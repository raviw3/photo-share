#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { PhotoShareStack } from '../lib/photoshare-stack';

const app = new cdk.App();

new PhotoShareStack(app, 'PhotoShareStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'ap-south-1',
  },
  description: 'PhotoShare — full-stack image sharing app infrastructure',
});
