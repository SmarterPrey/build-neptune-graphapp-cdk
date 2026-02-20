"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Api = void 0;
const aws_cdk_lib_1 = require("aws-cdk-lib");
const aws_appsync_1 = require("aws-cdk-lib/aws-appsync");
const constructs_1 = require("constructs");
const cdk_nag_1 = require("cdk-nag");
class Api extends constructs_1.Construct {
    constructor(scope, id, props) {
        super(scope, id);
        const { schema, vpc, cluster, clusterRole, graphqlFieldName, s3Uri } = props;
        // AWS AppSync
        const graphql = new aws_appsync_1.GraphqlApi(this, "graphql", {
            name: id,
            definition: aws_appsync_1.Definition.fromFile(schema),
            logConfig: {
                fieldLogLevel: aws_appsync_1.FieldLogLevel.ERROR,
                role: new aws_cdk_lib_1.aws_iam.Role(this, "appsync-log-role", {
                    assumedBy: new aws_cdk_lib_1.aws_iam.ServicePrincipal("appsync.amazonaws.com"),
                    inlinePolicies: {
                        logs: new aws_cdk_lib_1.aws_iam.PolicyDocument({
                            statements: [
                                new aws_cdk_lib_1.aws_iam.PolicyStatement({
                                    actions: [
                                        "logs:CreateLogGroup",
                                        "logs:CreateLogStream",
                                        "logs:PutLogEvents",
                                    ],
                                    resources: [
                                        `arn:aws:logs:${aws_cdk_lib_1.Stack.of(this).region}:${aws_cdk_lib_1.Stack.of(this).account}`,
                                    ],
                                }),
                            ],
                        }),
                    },
                }),
            },
            authorizationConfig: {
                defaultAuthorization: {
                    authorizationType: aws_appsync_1.AuthorizationType.USER_POOL,
                    userPoolConfig: {
                        userPool: props.cognito.userPool,
                        appIdClientRegex: props.cognito.cognitoParams.userPoolClientId,
                        defaultAction: aws_appsync_1.UserPoolDefaultAction.ALLOW,
                    },
                },
            },
            xrayEnabled: true,
        });
        this.graphqlUrl = graphql.graphqlUrl;
        const lambdaRole = new aws_cdk_lib_1.aws_iam.Role(this, "lambdaRole", {
            assumedBy: new aws_cdk_lib_1.aws_iam.ServicePrincipal("lambda.amazonaws.com"),
        });
        lambdaRole.addToPrincipalPolicy(new aws_cdk_lib_1.aws_iam.PolicyStatement({
            resources: ["*"],
            actions: [
                "logs:CreateLogGroup",
                "logs:CreateLogStream",
                "logs:PutLogEvents",
                "ec2:CreateNetworkInterface",
                "ec2:DescribeNetworkInterfaces",
                "ec2:DescribeSubnets",
                "ec2:DeleteNetworkInterface",
                "ec2:AssignPrivateIpAddresses",
                "ec2:UnassignPrivateIpAddresses",
            ],
        }));
        cluster.grantConnect(lambdaRole);
        // AWS Lambda for graph application
        const NodejsFunctionBaseProps = {
            runtime: aws_cdk_lib_1.aws_lambda.Runtime.NODEJS_20_X,
            // entry: `./api/lambda/${lambdaName}.ts`,
            depsLockFilePath: "./api/lambda/package-lock.json",
            architecture: aws_cdk_lib_1.aws_lambda.Architecture.ARM_64,
            timeout: aws_cdk_lib_1.Duration.minutes(1),
            role: lambdaRole,
            vpc: vpc,
            vpcSubnets: {
                subnets: vpc.isolatedSubnets,
            },
            bundling: {
                nodeModules: ["gremlin", "gremlin-aws-sigv4"],
            },
        };
        const queryFn = new aws_cdk_lib_1.aws_lambda_nodejs.NodejsFunction(this, "queryFn", {
            ...NodejsFunctionBaseProps,
            entry: "./api/lambda/queryGraph.ts",
            environment: {
                NEPTUNE_ENDPOINT: cluster.clusterReadEndpoint.hostname,
                NEPTUNE_PORT: cluster.clusterReadEndpoint.port.toString(),
            },
        });
        graphql.grantQuery(queryFn);
        queryFn.connections.allowTo(cluster, aws_cdk_lib_1.aws_ec2.Port.tcp(8182));
        // AI Query Lambda (Bedrock + Neptune)
        const aiQueryRole = new aws_cdk_lib_1.aws_iam.Role(this, "aiQueryRole", {
            assumedBy: new aws_cdk_lib_1.aws_iam.ServicePrincipal("lambda.amazonaws.com"),
        });
        aiQueryRole.addToPrincipalPolicy(new aws_cdk_lib_1.aws_iam.PolicyStatement({
            resources: ["*"],
            actions: [
                "logs:CreateLogGroup",
                "logs:CreateLogStream",
                "logs:PutLogEvents",
                "ec2:CreateNetworkInterface",
                "ec2:DescribeNetworkInterfaces",
                "ec2:DescribeSubnets",
                "ec2:DeleteNetworkInterface",
                "ec2:AssignPrivateIpAddresses",
                "ec2:UnassignPrivateIpAddresses",
            ],
        }));
        aiQueryRole.addToPrincipalPolicy(new aws_cdk_lib_1.aws_iam.PolicyStatement({
            resources: [
                `arn:aws:bedrock:${aws_cdk_lib_1.Stack.of(this).region}::foundation-model/*`,
            ],
            actions: ["bedrock:InvokeModel"],
        }));
        cluster.grantConnect(aiQueryRole);
        const aiQueryFn = new aws_cdk_lib_1.aws_lambda_nodejs.NodejsFunction(this, "aiQueryFn", {
            ...NodejsFunctionBaseProps,
            entry: "./api/lambda/aiQuery.ts",
            role: aiQueryRole,
            timeout: aws_cdk_lib_1.Duration.minutes(2),
            environment: {
                NEPTUNE_ENDPOINT: cluster.clusterReadEndpoint.hostname,
                NEPTUNE_PORT: cluster.clusterReadEndpoint.port.toString(),
                BEDROCK_REGION: aws_cdk_lib_1.Stack.of(this).region,
                MODEL_ID: "anthropic.claude-3-haiku-20240307-v1:0",
            },
            bundling: {
                nodeModules: [
                    "gremlin",
                    "gremlin-aws-sigv4",
                    "@aws-sdk/client-bedrock-runtime",
                ],
            },
            vpcSubnets: {
                subnets: vpc.publicSubnets,
            },
            allowPublicSubnet: true,
        });
        graphql.grantQuery(aiQueryFn);
        aiQueryFn.connections.allowTo(cluster, aws_cdk_lib_1.aws_ec2.Port.tcp(8182));
        const mutationFn = new aws_cdk_lib_1.aws_lambda_nodejs.NodejsFunction(this, "mutationFn", {
            ...NodejsFunctionBaseProps,
            entry: "./api/lambda/mutationGraph.ts",
            environment: {
                NEPTUNE_ENDPOINT: cluster.clusterEndpoint.hostname,
                NEPTUNE_PORT: cluster.clusterEndpoint.port.toString(),
            },
        });
        graphql.grantMutation(mutationFn);
        mutationFn.connections.allowTo(cluster, aws_cdk_lib_1.aws_ec2.Port.tcp(8182));
        // Function URL
        const bulkLoadFn = new aws_cdk_lib_1.aws_lambda_nodejs.NodejsFunction(this, "bulkLoadFn", {
            ...NodejsFunctionBaseProps,
            entry: "./api/lambda/functionUrl/index.ts",
            depsLockFilePath: "./api/lambda/functionUrl/package-lock.json",
            environment: {
                NEPTUNE_ENDPOINT: cluster.clusterEndpoint.hostname,
                NEPTUNE_PORT: cluster.clusterEndpoint.port.toString(),
                VERTEX: s3Uri.vertex,
                EDGE: s3Uri.edge,
                ROLE_ARN: clusterRole.roleArn,
            },
            vpcSubnets: {
                subnets: vpc.publicSubnets,
            },
            bundling: {
                nodeModules: [
                    "@smithy/signature-v4",
                    "@aws-sdk/credential-provider-node",
                    "@aws-crypto/sha256-js",
                    "@smithy/protocol-http",
                ],
            },
            allowPublicSubnet: true,
        });
        bulkLoadFn.connections.allowTo(cluster, aws_cdk_lib_1.aws_ec2.Port.tcp(8182));
        const functionUrl = bulkLoadFn.addFunctionUrl({
            authType: aws_cdk_lib_1.aws_lambda.FunctionUrlAuthType.AWS_IAM,
            cors: {
                allowedMethods: [aws_cdk_lib_1.aws_lambda.HttpMethod.GET],
                allowedOrigins: ["*"],
                allowedHeaders: ["*"],
            },
            invokeMode: aws_cdk_lib_1.aws_lambda.InvokeMode.RESPONSE_STREAM,
        });
        graphqlFieldName.map((filedName) => {
            // Data sources
            let targetFn;
            if (filedName === "askGraph") {
                targetFn = aiQueryFn;
            }
            else if (filedName.startsWith("get")) {
                targetFn = queryFn;
            }
            else {
                targetFn = mutationFn;
            }
            const datasource = graphql.addLambdaDataSource(`${filedName}DS`, targetFn);
            queryFn.addEnvironment("GRAPHQL_ENDPOINT", this.graphqlUrl);
            // Resolver
            datasource.createResolver(`${filedName}Resolver`, {
                fieldName: `${filedName}`,
                typeName: filedName.startsWith("get") ? "Query" : "Mutation",
                requestMappingTemplate: aws_appsync_1.MappingTemplate.fromFile(`./api/graphql/resolvers/requests/${filedName}.vtl`),
                responseMappingTemplate: aws_appsync_1.MappingTemplate.fromFile("./api/graphql/resolvers/responses/default.vtl"),
            });
        });
        // Outputs
        new aws_cdk_lib_1.CfnOutput(this, "GraphqlUrl", {
            value: this.graphqlUrl,
        });
        new aws_cdk_lib_1.CfnOutput(this, "FunctionUrl", {
            value: functionUrl.url,
        });
        // Suppressions
        cdk_nag_1.NagSuppressions.addResourceSuppressions(graphql, [
            {
                id: "AwsSolutions-IAM5",
                reason: "Datasorce role",
            },
        ], true);
        cdk_nag_1.NagSuppressions.addResourceSuppressions(lambdaRole, [
            {
                id: "AwsSolutions-IAM5",
                reason: "Need the permission for accessing database in Vpc",
            },
        ], true);
        cdk_nag_1.NagSuppressions.addResourceSuppressions(aiQueryRole, [
            {
                id: "AwsSolutions-IAM5",
                reason: "Need the permission for Bedrock and VPC access",
            },
        ], true);
        cdk_nag_1.NagSuppressions.addStackSuppressions(aws_cdk_lib_1.Stack.of(this), [
            {
                id: "AwsSolutions-IAM4",
                reason: "CDK managed resource",
                appliesTo: [
                    "Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
                ],
            },
            {
                id: "AwsSolutions-L1",
                reason: "CDK managed resource",
            },
            {
                id: "AwsSolutions-IAM5",
                reason: "CDK managed resource",
                appliesTo: ["Resource::*"],
            },
        ]);
    }
}
exports.Api = Api;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXBpLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiYXBpLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7OztBQUFBLDZDQVFxQjtBQUNyQix5REFPaUM7QUFDakMsMkNBQXVDO0FBSXZDLHFDQUEwQztBQWtCMUMsTUFBYSxHQUFJLFNBQVEsc0JBQVM7SUFHaEMsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUFzQjtRQUM5RCxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBRWpCLE1BQU0sRUFBRSxNQUFNLEVBQUUsR0FBRyxFQUFFLE9BQU8sRUFBRSxXQUFXLEVBQUUsZ0JBQWdCLEVBQUUsS0FBSyxFQUFFLEdBQ2xFLEtBQUssQ0FBQztRQUVSLGNBQWM7UUFDZCxNQUFNLE9BQU8sR0FBRyxJQUFJLHdCQUFVLENBQUMsSUFBSSxFQUFFLFNBQVMsRUFBRTtZQUM5QyxJQUFJLEVBQUUsRUFBRTtZQUNSLFVBQVUsRUFBRSx3QkFBVSxDQUFDLFFBQVEsQ0FBQyxNQUFNLENBQUM7WUFDdkMsU0FBUyxFQUFFO2dCQUNULGFBQWEsRUFBRSwyQkFBYSxDQUFDLEtBQUs7Z0JBQ2xDLElBQUksRUFBRSxJQUFJLHFCQUFPLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxrQkFBa0IsRUFBRTtvQkFDL0MsU0FBUyxFQUFFLElBQUkscUJBQU8sQ0FBQyxnQkFBZ0IsQ0FBQyx1QkFBdUIsQ0FBQztvQkFDaEUsY0FBYyxFQUFFO3dCQUNkLElBQUksRUFBRSxJQUFJLHFCQUFPLENBQUMsY0FBYyxDQUFDOzRCQUMvQixVQUFVLEVBQUU7Z0NBQ1YsSUFBSSxxQkFBTyxDQUFDLGVBQWUsQ0FBQztvQ0FDMUIsT0FBTyxFQUFFO3dDQUNQLHFCQUFxQjt3Q0FDckIsc0JBQXNCO3dDQUN0QixtQkFBbUI7cUNBQ3BCO29DQUNELFNBQVMsRUFBRTt3Q0FDVCxnQkFBZ0IsbUJBQUssQ0FBQyxFQUFFLENBQUMsSUFBSSxDQUFDLENBQUMsTUFBTSxJQUNuQyxtQkFB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QUFFLG1EQUFtRDthQUM1RDtTQUNGLEVBQ0QsSUFBSSxDQUNMLENBQUM7UUFDRix5QkFBZSxDQUFDLHVCQUF1QixDQUNyQyxXQUFXLEVBQ1g7WUFDRTtnQkFDRSxFQUFFLEVBQUUsbUJBQW1CO2dCQUN2QixNQUFNLEVBQUUsZ0RBQWdEO2FBQ3pEO1NBQ0YsRUFDRCxJQUFJLENBQ0wsQ0FBQztRQUNGLHlCQUFlLENBQUMsb0JBQW9CLENBQUMsbUJBQUssQ0FBQyxFQUFFLENBQUMsSUFBSSxDQUFDLEVBQUU7WUFDbkQ7Z0JBQ0UsRUFBRSxFQUFFLG1CQUFtQjtnQkFDdkIsTUFBTSxFQUFFLHNCQUFzQjtnQkFDOUIsU0FBUyxFQUFFO29CQUNULHVGQUF1RjtpQkFDeEY7YUFDRjtZQUNEO2dCQUNFLEVBQUUsRUFBRSxpQkFBaUI7Z0JBQ3JCLE1BQU0sRUFBRSxzQkFBc0I7YUFDL0I7WUFDRDtnQkFDRSxFQUFFLEVBQUUsbUJBQW1CO2dCQUN2QixNQUFNLEVBQUUsc0JBQXNCO2dCQUM5QixTQUFTLEVBQUUsQ0FBQyxhQUFhLENBQUM7YUFDM0I7U0FDRixDQUFDLENBQUM7SUFDTCxDQUFDO0NBQ0Y7QUFsVEQsa0JBa1RDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHtcbiAgU3RhY2ssXG4gIER1cmF0aW9uLFxuICBhd3NfZWMyLFxuICBhd3NfbGFtYmRhX25vZGVqcyxcbiAgYXdzX2xhbWJkYSxcbiAgYXdzX2lhbSxcbiAgQ2ZuT3V0cHV0LFxufSBmcm9tIFwiYXdzLWNkay1saWJcIjtcbmltcG9ydCB7XG4gIEF1dGhvcml6YXRpb25UeXBlLFxuICBEZWZpbml0aW9uLFxuICBGaWVsZExvZ0xldmVsLFxuICBHcmFwaHFsQXBpLFxuICBNYXBwaW5nVGVtcGxhdGUsXG4gIFVzZXJQb29sRGVmYXVsdEFjdGlvbixcbn0gZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcHBzeW5jXCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuXG5pbXBvcnQgKiBhcyBuZXB0dW5lIGZyb20gXCJAYXdzLWNkay9hd3MtbmVwdHVuZS1hbHBoYVwiO1xuXG5pbXBvcnQgeyBOYWdTdXBwcmVzc2lvbnMgfSBmcm9tIFwiY2RrLW5hZ1wiO1xuaW1wb3J0IHsgQ29nbml0byB9IGZyb20gXCIuL2NvZ25pdG9cIjtcblxuZXhwb3J0IGludGVyZmFjZSBCYWNrZW5kQXBpUHJvcHMge1xuICBzY2hlbWE6IHN0cmluZztcbiAgY29nbml0bzogQ29nbml0bztcbiAgdnBjOiBhd3NfZWMyLlZwYztcbiAgY2x1c3RlcjogbmVwdHVuZS5EYXRhYmFzZUNsdXN0ZXI7XG4gIGNsdXN0ZXJSb2xlOiBhd3NfaWFtLlJvbGU7XG4gIGdyYXBocWxGaWVsZE5hbWU6IHN0cmluZ1tdO1xuICBzM1VyaTogUzNVcmk7XG59XG5cbmV4cG9ydCB0eXBlIFMzVXJpID0ge1xuICB2ZXJ0ZXg6IHN0cmluZztcbiAgZWRnZTogc3RyaW5nO1xufTtcblxuZXhwb3J0IGNsYXNzIEFwaSBleHRlbmRzIENvbnN0cnVjdCB7XG4gIHJlYWRvbmx5IGdyYXBocWxVcmw6IHN0cmluZztcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQmFja2VuZEFwaVByb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgIGNvbnN0IHsgc2NoZW1hLCB2cGMsIGNsdXN0ZXIsIGNsdXN0ZXJSb2xlLCBncmFwaHFsRmllbGROYW1lLCBzM1VyaSB9ID1cbiAgICAgIHByb3BzO1xuXG4gICAgLy8gQVdTIEFwcFN5bmNcbiAgICBjb25zdCBncmFwaHFsID0gbmV3IEdyYXBocWxBcGkodGhpcywgXCJncmFwaHFsXCIsIHtcbiAgICAgIG5hbWU6IGlkLFxuICAgICAgZGVmaW5pdGlvbjogRGVmaW5pdGlvbi5mcm9tRmlsZShzY2hlbWEpLFxuICAgICAgbG9nQ29uZmlnOiB7XG4gICAgICAgIGZpZWxkTG9nTGV2ZWw6IEZpZWxkTG9nTGV2ZWwuRVJST1IsXG4gICAgICAgIHJvbGU6IG5ldyBhd3NfaWFtLlJvbGUodGhpcywgXCJhcHBzeW5jLWxvZy1yb2xlXCIsIHtcbiAgICAgICAgICBhc3N1bWVkQnk6IG5ldyBhd3NfaWFtLlNlcnZpY2VQcmluY2lwYWwoXCJhcHBzeW5jLmFtYXpvbmF3cy5jb21cIiksXG4gICAgICAgICAgaW5saW5lUG9saWNpZXM6IHtcbiAgICAgICAgICAgIGxvZ3M6IG5ldyBhd3NfaWFtLlBvbGljeURvY3VtZW50KHtcbiAgICAgICAgICAgICAgc3RhdGVtZW50czogW1xuICAgICAgICAgICAgICAgIG5ldyBhd3NfaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgICAgICAgICAgICBhY3Rpb25zOiBbXG4gICAgICAgICAgICAgICAgICAgIFwibG9nczpDcmVhdGVMb2dHcm91cFwiLFxuICAgICAgICAgICAgICAgICAgICBcImxvZ3M6Q3JlYXRlTG9nU3RyZWFtXCIsXG4gICAgICAgICAgICAgICAgICAgIFwibG9nczpQdXRMb2dFdmVudHNcIixcbiAgICAgICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgICAgICByZXNvdXJjZXM6IFtcbiAgICAgICAgICAgICAgICAgICAgYGFybjphd3M6bG9nczoke1N0YWNrLm9mKHRoaXMpLnJlZ2lvbn06JHtcbiAgICAgICAgICAgICAgICAgICAgICBTdGFjay5vZih0aGlzKS5hY2NvdW50XG4gICAgICAgICAgICAgICAgICAgIH1gLFxuICAgICAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgICB9KSxcbiAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgIH0pLFxuICAgICAgICAgIH0sXG4gICAgICAgIH0pLFxuICAgICAgfSxcbiAgICAgIGF1dGhvcml6YXRpb25Db25maWc6IHtcbiAgICAgICAgZGVmYXVsdEF1dGhvcml6YXRpb246IHtcbiAgICAgICAgICBhdXRob3JpemF0aW9uVHlwZTogQXV0aG9yaXphdGlvblR5cGUuVVNFUl9QT09MLFxuICAgICAgICAgIHVzZXJQb29sQ29uZmlnOiB7XG4gICAgICAgICAgICB1c2VyUG9vbDogcHJvcHMuY29nbml0by51c2VyUG9vbCxcbiAgICAgICAgICAgIGFwcElkQ2xpZW50UmVnZXg6IHByb3BzLmNvZ25pdG8uY29nbml0b1BhcmFtcy51c2VyUG9vbENsaWVudElkLFxuICAgICAgICAgICAgZGVmYXVsdEFjdGlvbjogVXNlclBvb2xEZWZhdWx0QWN0aW9uLkFMTE9XLFxuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgICAgeHJheUVuYWJsZWQ6IHRydWUsXG4gICAgfSk7XG5cbiAgICB0aGlzLmdyYXBocWxVcmwgPSBncmFwaHFsLmdyYXBocWxVcmw7XG5cbiAgICBjb25zdCBsYW1iZGFSb2xlID0gbmV3IGF3c19pYW0uUm9sZSh0aGlzLCBcImxhbWJkYVJvbGVcIiwge1xuICAgICAgYXNzdW1lZEJ5OiBuZXcgYXdzX2lhbS5TZXJ2aWNlUHJpbmNpcGFsKFwibGFtYmRhLmFtYXpvbmF3cy5jb21cIiksXG4gICAgfSk7XG4gICAgbGFtYmRhUm9sZS5hZGRUb1ByaW5jaXBhbFBvbGljeShcbiAgICAgIG5ldyBhd3NfaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgIHJlc291cmNlczogW1wiKlwiXSxcbiAgICAgICAgYWN0aW9uczogW1xuICAgICAgICAgIFwibG9nczpDcmVhdGVMb2dHcm91cFwiLFxuICAgICAgICAgIFwibG9nczpDcmVhdGVMb2dTdHJlYW1cIixcbiAgICAgICAgICBcImxvZ3M6UHV0TG9nRXZlbnRzXCIsXG4gICAgICAgICAgXCJlYzI6Q3JlYXRlTmV0d29ya0ludGVyZmFjZVwiLFxuICAgICAgICAgIFwiZWMyOkRlc2NyaWJlTmV0d29ya0ludGVyZmFjZXNcIixcbiAgICAgICAgICBcImVjMjpEZXNjcmliZVN1Ym5ldHNcIixcbiAgICAgICAgICBcImVjMjpEZWxldGVOZXR3b3JrSW50ZXJmYWNlXCIsXG4gICAgICAgICAgXCJlYzI6QXNzaWduUHJpdmF0ZUlwQWRkcmVzc2VzXCIsXG4gICAgICAgICAgXCJlYzI6VW5hc3NpZ25Qcml2YXRlSXBBZGRyZXNzZXNcIixcbiAgICAgICAgXSxcbiAgICAgIH0pXG4gICAgKTtcbiAgICBjbHVzdGVyLmdyYW50Q29ubmVjdChsYW1iZGFSb2xlKTtcblxuICAgIC8vIEFXUyBMYW1iZGEgZm9yIGdyYXBoIGFwcGxpY2F0aW9uXG4gICAgY29uc3QgTm9kZWpzRnVuY3Rpb25CYXNlUHJvcHM6IGF3c19sYW1iZGFfbm9kZWpzLk5vZGVqc0Z1bmN0aW9uUHJvcHMgPSB7XG4gICAgICBydW50aW1lOiBhd3NfbGFtYmRhLlJ1bnRpbWUuTk9ERUpTXzIwX1gsXG5cbiAgICAgIC8vIGVudHJ5OiBgLi9hcGkvbGFtYmRhLyR7bGFtYmRhTmFtZX0udHNgLFxuICAgICAgZGVwc0xvY2tGaWxlUGF0aDogXCIuL2FwaS9sYW1iZGEvcGFja2FnZS1sb2NrLmpzb25cIixcbiAgICAgIGFyY2hpdGVjdHVyZTogYXdzX2xhbWJkYS5BcmNoaXRlY3R1cmUuQVJNXzY0LFxuICAgICAgdGltZW91dDogRHVyYXRpb24ubWludXRlcygxKSxcbiAgICAgIHJvbGU6IGxhbWJkYVJvbGUsXG4gICAgICB2cGM6IHZwYyxcbiAgICAgIHZwY1N1Ym5ldHM6IHtcbiAgICAgICAgc3VibmV0czogdnBjLmlzb2xhdGVkU3VibmV0cyxcbiAgICAgIH0sXG4gICAgICBidW5kbGluZzoge1xuICAgICAgICBub2RlTW9kdWxlczogW1wiZ3JlbWxpblwiLCBcImdyZW1saW4tYXdzLXNpZ3Y0XCJdLFxuICAgICAgfSxcbiAgICB9O1xuICAgIGNvbnN0IHF1ZXJ5Rm4gPSBuZXcgYXdzX2xhbWJkYV9ub2RlanMuTm9kZWpzRnVuY3Rpb24odGhpcywgXCJxdWVyeUZuXCIsIHtcbiAgICAgIC4uLk5vZGVqc0Z1bmN0aW9uQmFzZVByb3BzLFxuICAgICAgZW50cnk6IFwiLi9hcGkvbGFtYmRhL3F1ZXJ5R3JhcGgudHNcIixcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIE5FUFRVTkVfRU5EUE9JTlQ6IGNsdXN0ZXIuY2x1c3RlclJlYWRFbmRwb2ludC5ob3N0bmFtZSxcbiAgICAgICAgTkVQVFVORV9QT1JUOiBjbHVzdGVyLmNsdXN0ZXJSZWFkRW5kcG9pbnQucG9ydC50b1N0cmluZygpLFxuICAgICAgfSxcbiAgICB9KTtcbiAgICBncmFwaHFsLmdyYW50UXVlcnkocXVlcnlGbik7XG4gICAgcXVlcnlGbi5jb25uZWN0aW9ucy5hbGxvd1RvKGNsdXN0ZXIsIGF3c19lYzIuUG9ydC50Y3AoODE4MikpO1xuXG4gICAgLy8gQUkgUXVlcnkgTGFtYmRhIChCZWRyb2NrICsgTmVwdHVuZSlcbiAgICBjb25zdCBhaVF1ZXJ5Um9sZSA9IG5ldyBhd3NfaWFtLlJvbGUodGhpcywgXCJhaVF1ZXJ5Um9sZVwiLCB7XG4gICAgICBhc3N1bWVkQnk6IG5ldyBhd3NfaWFtLlNlcnZpY2VQcmluY2lwYWwoXCJsYW1iZGEuYW1hem9uYXdzLmNvbVwiKSxcbiAgICB9KTtcbiAgICBhaVF1ZXJ5Um9sZS5hZGRUb1ByaW5jaXBhbFBvbGljeShcbiAgICAgIG5ldyBhd3NfaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgIHJlc291cmNlczogW1wiKlwiXSxcbiAgICAgICAgYWN0aW9uczogW1xuICAgICAgICAgIFwibG9nczpDcmVhdGVMb2dHcm91cFwiLFxuICAgICAgICAgIFwibG9nczpDcmVhdGVMb2dTdHJlYW1cIixcbiAgICAgICAgICBcImxvZ3M6UHV0TG9nRXZlbnRzXCIsXG4gICAgICAgICAgXCJlYzI6Q3JlYXRlTmV0d29ya0ludGVyZmFjZVwiLFxuICAgICAgICAgIFwiZWMyOkRlc2NyaWJlTmV0d29ya0ludGVyZmFjZXNcIixcbiAgICAgICAgICBcImVjMjpEZXNjcmliZVN1Ym5ldHNcIixcbiAgICAgICAgICBcImVjMjpEZWxldGVOZXR3b3JrSW50ZXJmYWNlXCIsXG4gICAgICAgICAgXCJlYzI6QXNzaWduUHJpdmF0ZUlwQWRkcmVzc2VzXCIsXG4gICAgICAgICAgXCJlYzI6VW5hc3NpZ25Qcml2YXRlSXBBZGRyZXNzZXNcIixcbiAgICAgICAgXSxcbiAgICAgIH0pXG4gICAgKTtcbiAgICBhaVF1ZXJ5Um9sZS5hZGRUb1ByaW5jaXBhbFBvbGljeShcbiAgICAgIG5ldyBhd3NfaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgIHJlc291cmNlczogW1xuICAgICAgICAgIGBhcm46YXdzOmJlZHJvY2s6JHtTdGFjay5vZih0aGlzKS5yZWdpb259Ojpmb3VuZGF0aW9uLW1vZGVsLypgLFxuICAgICAgICBdLFxuICAgICAgICBhY3Rpb25zOiBbXCJiZWRyb2NrOkludm9rZU1vZGVsXCJdLFxuICAgICAgfSlcbiAgICApO1xuICAgIGNsdXN0ZXIuZ3JhbnRDb25uZWN0KGFpUXVlcnlSb2xlKTtcblxuICAgIGNvbnN0IGFpUXVlcnlGbiA9IG5ldyBhd3NfbGFtYmRhX25vZGVqcy5Ob2RlanNGdW5jdGlvbihcbiAgICAgIHRoaXMsXG4gICAgICBcImFpUXVlcnlGblwiLFxuICAgICAge1xuICAgICAgICAuLi5Ob2RlanNGdW5jdGlvbkJhc2VQcm9wcyxcbiAgICAgICAgZW50cnk6IFwiLi9hcGkvbGFtYmRhL2FpUXVlcnkudHNcIixcbiAgICAgICAgcm9sZTogYWlRdWVyeVJvbGUsXG4gICAgICAgIHRpbWVvdXQ6IER1cmF0aW9uLm1pbnV0ZXMoMiksXG4gICAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgICAgTkVQVFVORV9FTkRQT0lOVDogY2x1c3Rlci5jbHVzdGVyUmVhZEVuZHBvaW50Lmhvc3RuYW1lLFxuICAgICAgICAgIE5FUFRVTkVfUE9SVDogY2x1c3Rlci5jbHVzdGVyUmVhZEVuZHBvaW50LnBvcnQudG9TdHJpbmcoKSxcbiAgICAgICAgICBCRURST0NLX1JFR0lPTjogU3RhY2sub2YodGhpcykucmVnaW9uLFxuICAgICAgICAgIE1PREVMX0lEOiBcImFudGhyb3BpYy5jbGF1ZGUtMy1oYWlrdS0yMDI0MDMwNy12MTowXCIsXG4gICAgICAgIH0sXG4gICAgICAgIGJ1bmRsaW5nOiB7XG4gICAgICAgICAgbm9kZU1vZHVsZXM6IFtcbiAgICAgICAgICAgIFwiZ3JlbWxpblwiLFxuICAgICAgICAgICAgXCJncmVtbGluLWF3cy1zaWd2NFwiLFxuICAgICAgICAgICAgXCJAYXdzLXNkay9jbGllbnQtYmVkcm9jay1ydW50aW1lXCIsXG4gICAgICAgICAgXSxcbiAgICAgICAgfSxcbiAgICAgICAgdnBjU3VibmV0czoge1xuICAgICAgICAgIHN1Ym5ldHM6IHZwYy5wdWJsaWNTdWJuZXRzLFxuICAgICAgICB9LFxuICAgICAgICBhbGxvd1B1YmxpY1N1Ym5ldDogdHJ1ZSxcbiAgICAgIH1cbiAgICApO1xuICAgIGdyYXBocWwuZ3JhbnRRdWVyeShhaVF1ZXJ5Rm4pO1xuICAgIGFpUXVlcnlGbi5jb25uZWN0aW9ucy5hbGxvd1RvKGNsdXN0ZXIsIGF3c19lYzIuUG9ydC50Y3AoODE4MikpO1xuXG4gICAgY29uc3QgbXV0YXRpb25GbiA9IG5ldyBhd3NfbGFtYmRhX25vZGVqcy5Ob2RlanNGdW5jdGlvbihcbiAgICAgIHRoaXMsXG4gICAgICBcIm11dGF0aW9uRm5cIixcbiAgICAgIHtcbiAgICAgICAgLi4uTm9kZWpzRnVuY3Rpb25CYXNlUHJvcHMsXG4gICAgICAgIGVudHJ5OiBcIi4vYXBpL2xhbWJkYS9tdXRhdGlvbkdyYXBoLnRzXCIsXG4gICAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgICAgTkVQVFVORV9FTkRQT0lOVDogY2x1c3Rlci5jbHVzdGVyRW5kcG9pbnQuaG9zdG5hbWUsXG4gICAgICAgICAgTkVQVFVORV9QT1JUOiBjbHVzdGVyLmNsdXN0ZXJFbmRwb2ludC5wb3J0LnRvU3RyaW5nKCksXG4gICAgICAgIH0sXG4gICAgICB9XG4gICAgKTtcbiAgICBncmFwaHFsLmdyYW50TXV0YXRpb24obXV0YXRpb25Gbik7XG4gICAgbXV0YXRpb25Gbi5jb25uZWN0aW9ucy5hbGxvd1RvKGNsdXN0ZXIsIGF3c19lYzIuUG9ydC50Y3AoODE4MikpO1xuXG4gICAgLy8gRnVuY3Rpb24gVVJMXG5cbiAgICBjb25zdCBidWxrTG9hZEZuID0gbmV3IGF3c19sYW1iZGFfbm9kZWpzLk5vZGVqc0Z1bmN0aW9uKFxuICAgICAgdGhpcyxcbiAgICAgIFwiYnVsa0xvYWRGblwiLFxuICAgICAge1xuICAgICAgICAuLi5Ob2RlanNGdW5jdGlvbkJhc2VQcm9wcyxcbiAgICAgICAgZW50cnk6IFwiLi9hcGkvbGFtYmRhL2Z1bmN0aW9uVXJsL2luZGV4LnRzXCIsXG4gICAgICAgIGRlcHNMb2NrRmlsZVBhdGg6IFwiLi9hcGkvbGFtYmRhL2Z1bmN0aW9uVXJsL3BhY2thZ2UtbG9jay5qc29uXCIsXG4gICAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgICAgTkVQVFVORV9FTkRQT0lOVDogY2x1c3Rlci5jbHVzdGVyRW5kcG9pbnQuaG9zdG5hbWUsXG4gICAgICAgICAgTkVQVFVORV9QT1JUOiBjbHVzdGVyLmNsdXN0ZXJFbmRwb2ludC5wb3J0LnRvU3RyaW5nKCksXG4gICAgICAgICAgVkVSVEVYOiBzM1VyaS52ZXJ0ZXgsXG4gICAgICAgICAgRURHRTogczNVcmkuZWRnZSxcbiAgICAgICAgICBST0xFX0FSTjogY2x1c3RlclJvbGUucm9sZUFybixcbiAgICAgICAgfSxcbiAgICAgICAgdnBjU3VibmV0czoge1xuICAgICAgICAgIHN1Ym5ldHM6IHZwYy5wdWJsaWNTdWJuZXRzLFxuICAgICAgICB9LFxuICAgICAgICBidW5kbGluZzoge1xuICAgICAgICAgIG5vZGVNb2R1bGVzOiBbXG4gICAgICAgICAgICBcIkBzbWl0aHkvc2lnbmF0dXJlLXY0XCIsXG4gICAgICAgICAgICBcIkBhd3Mtc2RrL2NyZWRlbnRpYWwtcHJvdmlkZXItbm9kZVwiLFxuICAgICAgICAgICAgXCJAYXdzLWNyeXB0by9zaGEyNTYtanNcIixcbiAgICAgICAgICAgIFwiQHNtaXRoeS9wcm90b2NvbC1odHRwXCIsXG4gICAgICAgICAgXSxcbiAgICAgICAgfSxcbiAgICAgICAgYWxsb3dQdWJsaWNTdWJuZXQ6IHRydWUsXG4gICAgICB9XG4gICAgKTtcbiAgICBidWxrTG9hZEZuLmNvbm5lY3Rpb25zLmFsbG93VG8oY2x1c3RlciwgYXdzX2VjMi5Qb3J0LnRjcCg4MTgyKSk7XG5cbiAgICBjb25zdCBmdW5jdGlvblVybCA9IGJ1bGtMb2FkRm4uYWRkRnVuY3Rpb25Vcmwoe1xuICAgICAgYXV0aFR5cGU6IGF3c19sYW1iZGEuRnVuY3Rpb25VcmxBdXRoVHlwZS5BV1NfSUFNLFxuICAgICAgY29yczoge1xuICAgICAgICBhbGxvd2VkTWV0aG9kczogW2F3c19sYW1iZGEuSHR0cE1ldGhvZC5HRVRdLFxuICAgICAgICBhbGxvd2VkT3JpZ2luczogW1wiKlwiXSxcbiAgICAgICAgYWxsb3dlZEhlYWRlcnM6IFtcIipcIl0sXG4gICAgICB9LFxuXG4gICAgICBpbnZva2VNb2RlOiBhd3NfbGFtYmRhLkludm9rZU1vZGUuUkVTUE9OU0VfU1RSRUFNLFxuICAgIH0pO1xuXG4gICAgZ3JhcGhxbEZpZWxkTmFtZS5tYXAoKGZpbGVkTmFtZTogc3RyaW5nKSA9PiB7XG4gICAgICAvLyBEYXRhIHNvdXJjZXNcbiAgICAgIGxldCB0YXJnZXRGbjtcbiAgICAgIGlmIChmaWxlZE5hbWUgPT09IFwiYXNrR3JhcGhcIikge1xuICAgICAgICB0YXJnZXRGbiA9IGFpUXVlcnlGbjtcbiAgICAgIH0gZWxzZSBpZiAoZmlsZWROYW1lLnN0YXJ0c1dpdGgoXCJnZXRcIikpIHtcbiAgICAgICAgdGFyZ2V0Rm4gPSBxdWVyeUZuO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGFyZ2V0Rm4gPSBtdXRhdGlvbkZuO1xuICAgICAgfVxuICAgICAgY29uc3QgZGF0YXNvdXJjZSA9IGdyYXBocWwuYWRkTGFtYmRhRGF0YVNvdXJjZShcbiAgICAgICAgYCR7ZmlsZWROYW1lfURTYCxcbiAgICAgICAgdGFyZ2V0Rm5cbiAgICAgICk7XG4gICAgICBxdWVyeUZuLmFkZEVudmlyb25tZW50KFwiR1JBUEhRTF9FTkRQT0lOVFwiLCB0aGlzLmdyYXBocWxVcmwpO1xuICAgICAgLy8gUmVzb2x2ZXJcbiAgICAgIGRhdGFzb3VyY2UuY3JlYXRlUmVzb2x2ZXIoYCR7ZmlsZWROYW1lfVJlc29sdmVyYCwge1xuICAgICAgICBmaWVsZE5hbWU6IGAke2ZpbGVkTmFtZX1gLFxuICAgICAgICB0eXBlTmFtZTogZmlsZWROYW1lLnN0YXJ0c1dpdGgoXCJnZXRcIikgPyBcIlF1ZXJ5XCIgOiBcIk11dGF0aW9uXCIsXG4gICAgICAgIHJlcXVlc3RNYXBwaW5nVGVtcGxhdGU6IE1hcHBpbmdUZW1wbGF0ZS5mcm9tRmlsZShcbiAgICAgICAgICBgLi9hcGkvZ3JhcGhxbC9yZXNvbHZlcnMvcmVxdWVzdHMvJHtmaWxlZE5hbWV9LnZ0bGBcbiAgICAgICAgKSxcbiAgICAgICAgcmVzcG9uc2VNYXBwaW5nVGVtcGxhdGU6IE1hcHBpbmdUZW1wbGF0ZS5mcm9tRmlsZShcbiAgICAgICAgICBcIi4vYXBpL2dyYXBocWwvcmVzb2x2ZXJzL3Jlc3BvbnNlcy9kZWZhdWx0LnZ0bFwiXG4gICAgICAgICksXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIC8vIE91dHB1dHNcbiAgICBuZXcgQ2ZuT3V0cHV0KHRoaXMsIFwiR3JhcGhxbFVybFwiLCB7XG4gICAgICB2YWx1ZTogdGhpcy5ncmFwaHFsVXJsLFxuICAgIH0pO1xuICAgIG5ldyBDZm5PdXRwdXQodGhpcywgXCJGdW5jdGlvblVybFwiLCB7XG4gICAgICB2YWx1ZTogZnVuY3Rpb25VcmwudXJsLFxuICAgIH0pO1xuXG4gICAgLy8gU3VwcHJlc3Npb25zXG4gICAgTmFnU3VwcHJlc3Npb25zLmFkZFJlc291cmNlU3VwcHJlc3Npb25zKFxuICAgICAgZ3JhcGhxbCxcbiAgICAgIFtcbiAgICAgICAge1xuICAgICAgICAgIGlkOiBcIkF3c1NvbHV0aW9ucy1JQU01XCIsXG4gICAgICAgICAgcmVhc29uOiBcIkRhdGFzb3JjZSByb2xlXCIsXG4gICAgICAgIH0sXG4gICAgICBdLFxuICAgICAgdHJ1ZVxuICAgICk7XG5cbiAgICBOYWdTdXBwcmVzc2lvbnMuYWRkUmVzb3VyY2VTdXBwcmVzc2lvbnMoXG4gICAgICBsYW1iZGFSb2xlLFxuICAgICAgW1xuICAgICAgICB7XG4gICAgICAgICAgaWQ6IFwiQXdzU29sdXRpb25zLUlBTTVcIixcbiAgICAgICAgICByZWFzb246IFwiTmVlZCB0aGUgcGVybWlzc2lvbiBmb3IgYWNjZXNzaW5nIGRhdGFiYXNlIGluIFZwY1wiLFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICAgIHRydWVcbiAgICApO1xuICAgIE5hZ1N1cHByZXNzaW9ucy5hZGRSZXNvdXJjZVN1cHByZXNzaW9ucyhcbiAgICAgIGFpUXVlcnlSb2xlLFxuICAgICAgW1xuICAgICAgICB7XG4gICAgICAgICAgaWQ6IFwiQXdzU29sdXRpb25zLUlBTTVcIixcbiAgICAgICAgICByZWFzb246IFwiTmVlZCB0aGUgcGVybWlzc2lvbiBmb3IgQmVkcm9jayBhbmQgVlBDIGFjY2Vzc1wiLFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICAgIHRydWVcbiAgICApO1xuICAgIE5hZ1N1cHByZXNzaW9ucy5hZGRTdGFja1N1cHByZXNzaW9ucyhTdGFjay5vZih0aGlzKSwgW1xuICAgICAge1xuICAgICAgICBpZDogXCJBd3NTb2x1dGlvbnMtSUFNNFwiLFxuICAgICAgICByZWFzb246IFwiQ0RLIG1hbmFnZWQgcmVzb3VyY2VcIixcbiAgICAgICAgYXBwbGllc1RvOiBbXG4gICAgICAgICAgXCJQb2xpY3k6OmFybjo8QVdTOjpQYXJ0aXRpb24+OmlhbTo6YXdzOnBvbGljeS9zZXJ2aWNlLXJvbGUvQVdTTGFtYmRhQmFzaWNFeGVjdXRpb25Sb2xlXCIsXG4gICAgICAgIF0sXG4gICAgICB9LFxuICAgICAge1xuICAgICAgICBpZDogXCJBd3NTb2x1dGlvbnMtTDFcIixcbiAgICAgICAgcmVhc29uOiBcIkNESyBtYW5hZ2VkIHJlc291cmNlXCIsXG4gICAgICB9LFxuICAgICAge1xuICAgICAgICBpZDogXCJBd3NTb2x1dGlvbnMtSUFNNVwiLFxuICAgICAgICByZWFzb246IFwiQ0RLIG1hbmFnZWQgcmVzb3VyY2VcIixcbiAgICAgICAgYXBwbGllc1RvOiBbXCJSZXNvdXJjZTo6KlwiXSxcbiAgICAgIH0sXG4gICAgXSk7XG4gIH1cbn1cbiJdfQ==