# PhotoShare — AWS CDK Infrastructure

This directory contains the complete AWS infrastructure for PhotoShare, defined as code using AWS CDK (TypeScript).

## What gets created

| Resource | Details |
|---|---|
| VPC | 2 AZs, public + private subnets, 1 NAT Gateway |
| Cognito User Pool | Phone-only sign-in, SMS OTP via SNS |
| RDS PostgreSQL 15 | db.t3.micro, private subnet, credentials in Secrets Manager |
| MSK Kafka | 3.5.1, 1 broker (kafka.t3.small), private subnet |
| S3 Bucket | `photoshare-images-{accountId}-{region}`, private, CORS enabled |
| CloudFront | OAC origin, HTTPS redirect, CachingOptimized |
| ECS Fargate | 512 CPU / 1024 MB, pulls from ECR `photoshare-backend` |
| ALB | Public, forwards port 80 → ECS port 8080 |
| API Gateway | HTTP API, Cognito JWT authorizer, proxies to ALB |
| ECR | `photoshare-backend` repo, keeps last 5 images |

---

## Prerequisites

- Node.js 18+ and npm installed
- AWS CLI installed and configured (`aws configure`)
- AWS CDK CLI installed (`npm install -g aws-cdk`)

---

## Deploy steps

### 1. Install dependencies
```bash
cd photoshare-cdk
npm install
```

### 2. Bootstrap CDK (one-time per AWS account/region)
This creates a staging S3 bucket and IAM roles CDK needs internally.
```bash
cdk bootstrap aws://{YOUR_ACCOUNT_ID}/ap-south-1
```
Replace `{YOUR_ACCOUNT_ID}` with your 12-digit AWS account ID.  
Find it by running: `aws sts get-caller-identity`

### 3. Preview what will be created (optional but recommended)
```bash
cdk diff
```

### 4. Deploy the stack
```bash
cdk deploy
```
This takes approximately **10–15 minutes** the first time (RDS and MSK are slow to provision).

### 5. Copy the outputs
After deploy completes, CDK prints a block of **Outputs** in your terminal.
Copy and save all of them — you'll need them when configuring the Spring Boot app:

```
PhotoShareStack.ApiGatewayUrl     → EXPO_PUBLIC_API_URL in mobile app
PhotoShareStack.CloudFrontUrl     → CLOUDFRONT_URL in Spring Boot
PhotoShareStack.EcrRepositoryUri  → Docker image push target in CI/CD
PhotoShareStack.UserPoolId        → COGNITO_USER_POOL_ID in Spring Boot
PhotoShareStack.UserPoolClientId  → COGNITO_APP_CLIENT_ID in Spring Boot
PhotoShareStack.RdsEndpoint       → DB_HOST in Spring Boot
PhotoShareStack.S3BucketName      → S3_BUCKET in Spring Boot
```

### 6. Get the MSK Kafka bootstrap URL (manual step)
MSK bootstrap URLs are not available as CDK outputs.
After deploy, run:
```bash
aws kafka list-clusters --region ap-south-1
# Copy the ClusterArn from the output, then:
aws kafka get-bootstrap-brokers --cluster-arn {ClusterArn} --region ap-south-1
```
The `BootstrapBrokerString` value is your `KAFKA_BROKERS` env var.

---

## Destroy the stack (avoid ongoing charges)
```bash
cdk destroy
```
> ⚠️ This deletes **everything** including the RDS database and all S3 objects. Only run this when you're done learning.

---

## Important notes

- **First deploy only:** The ECS service will fail to start because no Docker image exists in ECR yet. This is expected. Push an image after completing Workflow 3 (Spring Boot), then the service will start.
- **MSK Kafka topics** (`image.uploaded`, `image.processed`) need to be created manually or via a Spring Boot config after deploy — see Workflow 3.
- **Cost estimate:** Running this stack 24/7 costs approximately $5–10/day (mostly RDS + MSK + NAT Gateway). Destroy it when not actively developing.
