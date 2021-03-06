/*
 * Copyright (c) 2018, salesforce.com, inc.
 * All rights reserved.
 * SPDX-License-Identifier: MIT
 * For full license text, see the LICENSE file in the repo root or https://opensource.org/licenses/MIT
 */

const fs = require('fs-extra');
const path = require('path');
const AWS = require('aws-sdk');
const execa = require('execa');
const { lookup } = require('mime-types');
require('dotenv').config();

// To invoke this from the commandline you need the following to env vars to exist:
//
// RELEASE_BUCKET_NAME
// RELEASE_SECRET_ACCESS_KEY
// RELEASE_ACCESS_KEY_ID
// RELEASE_REGION
//

const CONFIG = {
    accessKeyId: process.env.RELEASE_ACCESS_KEY_ID,
    secretAccessKey: process.env.RELEASE_SECRET_ACCESS_KEY,
    region: process.env.RELEASE_REGION,
};

const BUCKET = process.env.RELEASE_BUCKET_NAME;

let RELEASE_TTL;
if (process.env.RELEASE_TTL) {
    RELEASE_TTL = process.env.RELEASE_TTL;
} else if (process.env.CI && process.env.CIRCLE_BRANCH === 'master') {
    RELEASE_TTL = 1000 * 60 * 60 * 24 * 365 * 10; // 10 years.
} else {
    RELEASE_TTL = 1000 * 60 * 60 * 24 * 30; // 30 days.
}

const S3 = new AWS.S3(CONFIG);
const PREFIX = 'public';
const HOST = `https://${BUCKET}.s3.amazonaws.com`;

async function exec(command, args, options) {
    console.log(`\n\tRunning: \`${command} ${args.join(' ')}\``);
    const { stdout } = await execa(command, args, options);
    return stdout;
}

function generateUrl(packageName, sha) {
    return [PREFIX, 'builds', packageName, 'canary', `${sha}.tgz`].join('/');
}

function pushPackage({ sha, packageName, packageTar }) {
    return new Promise(function(resolve, reject) {
        const url = generateUrl(packageName, sha);
        S3.putObject(
            {
                Bucket: BUCKET,
                Key: url,
                Body: fs.readFileSync(packageTar),
                Expires: new Date(Date.now() + RELEASE_TTL),
                ContentType: lookup(url) || undefined,
            },
            function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve(url);
                }
            }
        );
    });
}

async function run() {
    const [sha] = process.argv.slice(2);

    if (!sha) {
        throw new Error('Releasing canary version require a git commit SHA to pin the package.');
    }

    // Find package.json
    const jsonPath = path.resolve('package.json');
    const pkgJson = require(jsonPath);

    // Override package.json
    const { name, version } = pkgJson;
    pkgJson._originalversion = version;
    pkgJson.version = `${version}-canary+${sha}`;

    fs.writeFileSync(jsonPath, JSON.stringify(pkgJson, null, 2), {
        encoding: 'utf-8',
    });

    // Generate tar artifact
    const tar = await exec('npm', ['pack']);
    const tarPath = path.resolve(tar);

    // Push package to S3
    process.stdout.write(`Pushing package: ${name}...`);
    const url = await pushPackage({
        packageName: name,
        sha,
        packageTar: tarPath,
    });
    process.stdout.write(` [DONE]\n Uploaded to: ${HOST}/${url}\n`);
}

run().catch(err => console.log(err));
