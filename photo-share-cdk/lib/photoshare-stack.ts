import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as msk from 'aws-cdk-lib/aws-msk';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as apigwv2authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';

export class PhotoShareStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // =========================================================
    // 1. VPC
    // =========================================================
    const vpc = new ec2.Vpc(this, 'PhotoShareVpc', {
      maxAzs: 2,
      natGateways: 1, // 1 NAT GW — cost-saving for learning
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
      ],
    });

    // =========================================================
    // 2. Cognito User Pool — phone number + SMS OTP
    // =========================================================
    const userPool = new cognito.UserPool(this, 'PhotoShareUserPool', {
      userPoolName: 'photoshare-user-pool',
      selfSignUpEnabled: true,
      signInAliases: {
        phone: true,
        email: false,
        username: false,
      },
      autoVerify: {
        phone: true,
      },
      mfa: cognito.Mfa.REQUIRED,
      mfaSecondFactor: {
        sms: true,
        otp: false,
      },
      passwordPolicy: {
        // Not relevant for phone OTP flow but CDK requires it
        minLength: 8,
        requireDigits: false,
        requireLowercase: false,
        requireSymbols: false,
        requireUppercase: false,
      },
      accountRecovery: cognito.AccountRecovery.NONE,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // safe to destroy in dev
    });

    // App client — no secret (mobile apps can't keep secrets)
    const userPoolClient = new cognito.UserPoolClient(this, 'PhotoShareUserPoolClient', {
      userPool,
      userPoolClientName: 'photoshare-mobile-client',
      generateSecret: false,
      authFlows: {
        userPassword: true,
        userSrp: true,
        custom: true,
        adminUserPassword: true,
      },
      disableOAuth: true,
      preventUserExistenceErrors: true,
    });

    // =========================================================
    // 3. RDS PostgreSQL 15
    // =========================================================

    // Security group for RDS — only allow inbound from within VPC
    const rdsSecurityGroup = new ec2.SecurityGroup(this, 'RdsSecurityGroup', {
      vpc,
      description: 'Security group for PhotoShare RDS instance',
      allowAllOutbound: false,
    });

    const dbCredentials = rds.Credentials.fromGeneratedSecret('photoshare_admin', {
      secretName: 'photoshare/rds/credentials',
    });

    const database = new rds.DatabaseInstance(this, 'PhotoShareDatabase', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_15,
      }),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        ec2.InstanceSize.MICRO
      ),
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      securityGroups: [rdsSecurityGroup],
      credentials: dbCredentials,
      databaseName: 'photoshare',
      multiAz: false, // learning / cost-saving
      allocatedStorage: 20,
      storageType: rds.StorageType.GP2,
      backupRetention: cdk.Duration.days(3),
      deletionProtection: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      // Enable automatic minor version upgrades
      autoMinorVersionUpgrade: true,
    });

    // =========================================================
    // 4. MSK Kafka Cluster
    // =========================================================
    const mskSecurityGroup = new ec2.SecurityGroup(this, 'MskSecurityGroup', {
      vpc,
      description: 'Security group for PhotoShare MSK cluster',
    });

    const mskCluster = new msk.CfnCluster(this, 'PhotoShareMskCluster', {
      clusterName: 'photoshare-kafka',
      kafkaVersion: '3.5.1',
      numberOfBrokerNodes: 2,
      brokerNodeGroupInfo: {
        instanceType: 'kafka.t3.small',
        clientSubnets: [
          vpc.privateSubnets[0].subnetId, // 1 broker → 2 subnets needed
          vpc.privateSubnets[1].subnetId
        ],
        securityGroups: [mskSecurityGroup.securityGroupId],
        storageInfo: {
          ebsStorageInfo: {
            volumeSize: 20, // GB
          },
        },
      },
      encryptionInfo: {
        encryptionInTransit: {
          clientBroker: 'TLS_PLAINTEXT',
          inCluster: true,
        },
      },
      clientAuthentication: {
        unauthenticated: {
          enabled: true, // simple setup for learning
        },
      },
    });

    // =========================================================
    // 5. S3 Bucket for images
    // =========================================================
    const imagesBucket = new s3.Bucket(this, 'PhotoShareImagesBucket', {
      bucketName: `photoshare-images-${this.account}-${this.region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true, // for easy teardown in dev
      cors: [
        {
          allowedMethods: [
            s3.HttpMethods.PUT,
            s3.HttpMethods.GET,
          ],
          allowedOrigins: ['*'],
          allowedHeaders: ['*'],
          maxAge: 3000,
        },
      ],
      lifecycleRules: [
        {
          id: 'TransitionToIA',
          enabled: true,
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: cdk.Duration.days(90),
            },
          ],
        },
      ],
    });

    // =========================================================
    // 6. CloudFront Distribution with OAC
    // =========================================================
    const oac = new cloudfront.S3OriginAccessControl(this, 'PhotoShareOAC', {
      description: 'OAC for PhotoShare images bucket',
      signing: cloudfront.Signing.SIGV4_NO_OVERRIDE,
    });

    const distribution = new cloudfront.Distribution(this, 'PhotoShareDistribution', {
      comment: 'PhotoShare CDN for user images',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(imagesBucket, {
          originAccessControl: oac,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        compress: true,
      },
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100, // cheapest — US/EU only
    });

    // Grant CloudFront OAC permission to read from S3
    imagesBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCloudFrontServicePrincipal',
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
        actions: ['s3:GetObject'],
        resources: [imagesBucket.arnForObjects('*')],
        conditions: {
          StringEquals: {
            'AWS:SourceArn': `arn:aws:cloudfront::${this.account}:distribution/${distribution.distributionId}`,
          },
        },
      })
    );

    // =========================================================
    // 7. ECR Repository
    // =========================================================
    const ecrRepository = new ecr.Repository(this, 'PhotoShareEcrRepo', {
      repositoryName: 'photoshare-backend',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
      lifecycleRules: [
        {
          maxImageCount: 5, // keep only last 5 images — cost saving
          description: 'Keep last 5 images',
        },
      ],
    });

    // =========================================================
    // 8. ECS Cluster + Fargate Service
    // =========================================================
    const cluster = new ecs.Cluster(this, 'PhotoShareCluster', {
      clusterName: 'photoshare-cluster',
      vpc,
      containerInsights: false, // disable to save cost in learning
    });

    // Task execution role — ECS agent uses this to pull image + read secrets
    const taskExecutionRole = new iam.Role(this, 'EcsTaskExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    // Task role — the Spring Boot app uses this at runtime
    const taskRole = new iam.Role(this, 'EcsTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    // Allow app to read/write S3
    imagesBucket.grantReadWrite(taskRole);

    // Allow app to read DB credentials from Secrets Manager
    database.secret?.grantRead(taskExecutionRole);
    database.secret?.grantRead(taskRole);

    // CloudWatch log group for ECS
    const logGroup = new logs.LogGroup(this, 'PhotoShareLogGroup', {
      logGroupName: '/ecs/photoshare-backend',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Fargate task definition
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'PhotoShareTaskDef', {
      memoryLimitMiB: 1024,
      cpu: 512,
      executionRole: taskExecutionRole,
      taskRole: taskRole,
    });

    const container = taskDefinition.addContainer('PhotoShareBackend', {
      image: ecs.ContainerImage.fromEcrRepository(ecrRepository, 'latest'),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'photoshare',
        logGroup,
      }),
      environment: {
        DB_HOST: database.instanceEndpoint.hostname,
        DB_PORT: database.instanceEndpoint.port.toString(),
        DB_NAME: 'photoshare',
        S3_BUCKET: imagesBucket.bucketName,
        CLOUDFRONT_URL: `https://${distribution.distributionDomainName}`,
        KAFKA_BROKERS: 'REPLACED_AFTER_MSK_DEPLOY', // MSK bootstrap URL known after deploy
        COGNITO_REGION: this.region,
        COGNITO_USER_POOL_ID: userPool.userPoolId,
        COGNITO_APP_CLIENT_ID: userPoolClient.userPoolClientId,
        SPRING_PROFILES_ACTIVE: 'prod',
      },
      secrets: {
        DB_USER: ecs.Secret.fromSecretsManager(database.secret!, 'username'),
        DB_PASS: ecs.Secret.fromSecretsManager(database.secret!, 'password'),
      },
      portMappings: [{ containerPort: 8080 }],
      healthCheck: {
        command: ['CMD-SHELL', 'curl -f http://localhost:8080/health || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(60),
      },
    });

    // Security group for ECS tasks
    const ecsSecurityGroup = new ec2.SecurityGroup(this, 'EcsSecurityGroup', {
      vpc,
      description: 'Security group for PhotoShare ECS tasks',
    });

    // Security group for ALB
    const albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      vpc,
      description: 'Security group for PhotoShare ALB',
    });
    albSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Allow HTTP from internet');
    albSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'Allow HTTPS from internet');

    // ECS only accepts traffic from ALB
    ecsSecurityGroup.addIngressRule(albSecurityGroup, ec2.Port.tcp(8080), 'Allow from ALB');

    // RDS only accepts traffic from ECS
    rdsSecurityGroup.addIngressRule(ecsSecurityGroup, ec2.Port.tcp(5432), 'Allow from ECS');

    // MSK only accepts traffic from ECS
    mskSecurityGroup.addIngressRule(ecsSecurityGroup, ec2.Port.tcp(9092), 'Allow Kafka plaintext from ECS');
    mskSecurityGroup.addIngressRule(ecsSecurityGroup, ec2.Port.tcp(9094), 'Allow Kafka TLS from ECS');

    // Application Load Balancer
    const alb = new elbv2.ApplicationLoadBalancer(this, 'PhotoShareAlb', {
      vpc,
      internetFacing: true,
      securityGroup: albSecurityGroup,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    const listener = alb.addListener('PhotoShareListener', {
      port: 80,
      open: true,
      defaultAction: elbv2.ListenerAction.fixedResponse(503, {
        contentType: 'text/plain',
        messageBody: 'Service not yet deployed',
      }),
    });

    // ECS Fargate Service
//     const fargateService = new ecs.FargateService(this, 'PhotoShareFargateService', {
//       cluster,
//       taskDefinition,
//       desiredCount: 1,
//       assignPublicIp: false,
//       vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
//       securityGroups: [ecsSecurityGroup],
//       healthCheckGracePeriod: cdk.Duration.seconds(120),
//     });

//     listener.addTargets('PhotoShareTargetGroup', {
//       port: 8080,
//       protocol: elbv2.ApplicationProtocol.HTTP,
//       targets: [fargateService],
//       healthCheck: {
//         path: '/health',
//         interval: cdk.Duration.seconds(30),
//         timeout: cdk.Duration.seconds(5),
//         healthyHttpCodes: '200',
//       },
//       deregistrationDelay: cdk.Duration.seconds(30),
//     });

    // =========================================================
    // 9. API Gateway HTTP API + Cognito JWT Authorizer
    // =========================================================
    const httpApi = new apigwv2.HttpApi(this, 'PhotoShareHttpApi', {
      apiName: 'photoshare-api',
      description: 'PhotoShare HTTP API — proxies to Spring Boot on ECS',
      corsPreflight: {
        allowHeaders: ['Authorization', 'Content-Type'],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.PUT,
          apigwv2.CorsHttpMethod.DELETE,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        allowOrigins: ['*'],
        maxAge: cdk.Duration.hours(1),
      },
    });

    // Cognito JWT Authorizer
    const authorizer = new apigwv2authorizers.HttpUserPoolAuthorizer(
      'PhotoShareAuthorizer',
      userPool,
      {
        userPoolClients: [userPoolClient],
        identitySource: ['$request.header.Authorization'],
      }
    );

    // ALB integration — API Gateway routes all requests to ALB
//     const albIntegration = new apigwv2integrations.HttpAlbIntegration(
//       'AlbIntegration',
//       listener,
//       { secureServerName: alb.loadBalancerDnsName }
//     );
//
//     // Public routes — no auth required
//     httpApi.addRoutes({
//       path: '/auth/initiate',
//       methods: [apigwv2.HttpMethod.POST],
//       integration: albIntegration,
//       // No authorizer — public
//     });
//
//     httpApi.addRoutes({
//       path: '/auth/verify',
//       methods: [apigwv2.HttpMethod.POST],
//       integration: albIntegration,
//       // No authorizer — public
//     });
//
//     httpApi.addRoutes({
//       path: '/health',
//       methods: [apigwv2.HttpMethod.GET],
//       integration: albIntegration,
//       // No authorizer — ALB health check
//     });
//
//     // Protected catch-all route — requires Cognito JWT
//     httpApi.addRoutes({
//       path: '/{proxy+}',
//       methods: [apigwv2.HttpMethod.ANY],
//       integration: albIntegration,
//       authorizer,
//     });

    // =========================================================
    // OUTPUTS — printed after cdk deploy, copy these values
    // =========================================================
    new cdk.CfnOutput(this, 'ApiGatewayUrl', {
      value: httpApi.apiEndpoint,
      description: 'API Gateway base URL — set this as EXPO_PUBLIC_API_URL in the mobile app',
      exportName: 'PhotoShareApiUrl',
    });

    new cdk.CfnOutput(this, 'CloudFrontUrl', {
      value: `https://${distribution.distributionDomainName}`,
      description: 'CloudFront CDN URL — set as CLOUDFRONT_URL in Spring Boot env',
      exportName: 'PhotoShareCdnUrl',
    });

    new cdk.CfnOutput(this, 'EcrRepositoryUri', {
      value: ecrRepository.repositoryUri,
      description: 'ECR URI — used in CI/CD to push Docker image',
      exportName: 'PhotoShareEcrUri',
    });

    new cdk.CfnOutput(this, 'UserPoolId', {
      value: userPool.userPoolId,
      description: 'Cognito User Pool ID — set as COGNITO_USER_POOL_ID in Spring Boot',
      exportName: 'PhotoShareUserPoolId',
    });

    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: userPoolClient.userPoolClientId,
      description: 'Cognito App Client ID — set as COGNITO_APP_CLIENT_ID in Spring Boot',
      exportName: 'PhotoShareUserPoolClientId',
    });

    new cdk.CfnOutput(this, 'RdsEndpoint', {
      value: database.instanceEndpoint.hostname,
      description: 'RDS hostname — set as DB_HOST in Spring Boot',
      exportName: 'PhotoShareRdsEndpoint',
    });

    new cdk.CfnOutput(this, 'S3BucketName', {
      value: imagesBucket.bucketName,
      description: 'S3 bucket name — set as S3_BUCKET in Spring Boot',
      exportName: 'PhotoShareS3Bucket',
    });

    new cdk.CfnOutput(this, 'AlbDnsName', {
      value: alb.loadBalancerDnsName,
      description: 'ALB DNS name — for debugging / direct access',
    });
  }
}
