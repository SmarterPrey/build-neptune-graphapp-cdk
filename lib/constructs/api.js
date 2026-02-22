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
                subnets: vpc.isolatedSubnets,
            },
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
                typeName: filedName.startsWith("get") || filedName.startsWith("ask")
                    ? "Query"
                    : "Mutation",
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXBpLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiYXBpLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7OztBQUFBLDZDQVFxQjtBQUNyQix5REFPaUM7QUFDakMsMkNBQXVDO0FBSXZDLHFDQUEwQztBQWtCMUMsTUFBYSxHQUFJLFNBQVEsc0JBQVM7SUFHaEMsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUFzQjtRQUM5RCxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBRWpCLE1BQU0sRUFBRSxNQUFNLEVBQUUsR0FBRyxFQUFFLE9BQU8sRUFBRSxXQUFXLEVBQUUsZ0JBQWdCLEVBQUUsS0FBSyxFQUFFLEdBQ2xFLEtBQUssQ0FBQztRQUVSLGNBQWM7UUFDZCxNQUFNLE9BQU8sR0FBRyxJQUFJLHdCQUFVLENBQUMsSUFBSSxFQUFFLFNBQVMsRUFBRTtZQUM5QyxJQUFJLEVBQUUsRUFBRTtZQUNSLFVBQVUsRUFBRSx3QkFBVSxDQUFDLFFBQVEsQ0FBQyxNQUFNLENBQUM7WUFDdkMsU0FBUyxFQUFFO2dCQUNULGFBQWEsRUFBRSwyQkFBYSxDQUFDLEtBQUs7Z0JBQ2xDLElBQUksRUFBRSxJQUFJLHFCQUFPLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxrQkFBa0IsRUFBRTtvQkFDL0MsU0FBUyxFQUFFLElBQUkscUJBQU8sQ0FBQyxnQkFBZ0IsQ0FBQyx1QkFBdUIsQ0FBQztvQkFDaEUsY0FBYyxFQUFFO3dCQUNkLElBQUksRUFBRSxJQUFJLHFCQUFPLENBQUMsY0FBYyxDQUFDOzRCQUMvQixVQUFVLEVBQUU7Z0NBQ1YsSUFBSSxxQkFBTyxDQUFDLGVBQWUsQ0FBQztvQ0FDMUIsT0FBTyxFQUFFO3dDQUNQLHFCQUFxQjt3Q0FDckIsc0JBQXNCO3dDQUN0QixtQkFBbUI7cUNBQ3BCO29DQUNELFNBQVMsRUFBRTt3Q0FDVCxnQkFBZ0IsbUJBQUssQ0FBQyxFQUFFLENBQUMsSUFBSSxDQUFDLENBQUMsTUFBTSxJQUNuQyxtQkFB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O2dCQUN2QixNQUFNLEVBQUUsbURBQW1EO2FBQzVEO1NBQ0YsRUFDRCxJQUFJLENBQ0wsQ0FBQztRQUNGLHlCQUFlLENBQUMsdUJBQXVCLENBQ3JDLFdBQVcsRUFDWDtZQUNFO2dCQUNFLEVBQUUsRUFBRSxtQkFBbUI7Z0JBQ3ZCLE1BQU0sRUFBRSxnREFBZ0Q7YUFDekQ7U0FDRixFQUNELElBQUksQ0FDTCxDQUFDO1FBQ0YseUJBQWUsQ0FBQyxvQkFBb0IsQ0FBQyxtQkFBSyxDQUFDLEVBQUUsQ0FBQyxJQUFJLENBQUMsRUFBRTtZQUNuRDtnQkFDRSxFQUFFLEVBQUUsbUJBQW1CO2dCQUN2QixNQUFNLEVBQUUsc0JBQXNCO2dCQUM5QixTQUFTLEVBQUU7b0JBQ1QsdUZBQXVGO2lCQUN4RjthQUNGO1lBQ0Q7Z0JBQ0UsRUFBRSxFQUFFLGlCQUFpQjtnQkFDckIsTUFBTSxFQUFFLHNCQUFzQjthQUMvQjtZQUNEO2dCQUNFLEVBQUUsRUFBRSxtQkFBbUI7Z0JBQ3ZCLE1BQU0sRUFBRSxzQkFBc0I7Z0JBQzlCLFNBQVMsRUFBRSxDQUFDLGFBQWEsQ0FBQzthQUMzQjtTQUNGLENBQUMsQ0FBQztJQUNMLENBQUM7Q0FDRjtBQW5URCxrQkFtVEMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQge1xuICBTdGFjayxcbiAgRHVyYXRpb24sXG4gIGF3c19lYzIsXG4gIGF3c19sYW1iZGFfbm9kZWpzLFxuICBhd3NfbGFtYmRhLFxuICBhd3NfaWFtLFxuICBDZm5PdXRwdXQsXG59IGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0IHtcbiAgQXV0aG9yaXphdGlvblR5cGUsXG4gIERlZmluaXRpb24sXG4gIEZpZWxkTG9nTGV2ZWwsXG4gIEdyYXBocWxBcGksXG4gIE1hcHBpbmdUZW1wbGF0ZSxcbiAgVXNlclBvb2xEZWZhdWx0QWN0aW9uLFxufSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWFwcHN5bmNcIjtcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gXCJjb25zdHJ1Y3RzXCI7XG5cbmltcG9ydCAqIGFzIG5lcHR1bmUgZnJvbSBcIkBhd3MtY2RrL2F3cy1uZXB0dW5lLWFscGhhXCI7XG5cbmltcG9ydCB7IE5hZ1N1cHByZXNzaW9ucyB9IGZyb20gXCJjZGstbmFnXCI7XG5pbXBvcnQgeyBDb2duaXRvIH0gZnJvbSBcIi4vY29nbml0b1wiO1xuXG5leHBvcnQgaW50ZXJmYWNlIEJhY2tlbmRBcGlQcm9wcyB7XG4gIHNjaGVtYTogc3RyaW5nO1xuICBjb2duaXRvOiBDb2duaXRvO1xuICB2cGM6IGF3c19lYzIuVnBjO1xuICBjbHVzdGVyOiBuZXB0dW5lLkRhdGFiYXNlQ2x1c3RlcjtcbiAgY2x1c3RlclJvbGU6IGF3c19pYW0uUm9sZTtcbiAgZ3JhcGhxbEZpZWxkTmFtZTogc3RyaW5nW107XG4gIHMzVXJpOiBTM1VyaTtcbn1cblxuZXhwb3J0IHR5cGUgUzNVcmkgPSB7XG4gIHZlcnRleDogc3RyaW5nO1xuICBlZGdlOiBzdHJpbmc7XG59O1xuXG5leHBvcnQgY2xhc3MgQXBpIGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgcmVhZG9ubHkgZ3JhcGhxbFVybDogc3RyaW5nO1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBCYWNrZW5kQXBpUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgY29uc3QgeyBzY2hlbWEsIHZwYywgY2x1c3RlciwgY2x1c3RlclJvbGUsIGdyYXBocWxGaWVsZE5hbWUsIHMzVXJpIH0gPVxuICAgICAgcHJvcHM7XG5cbiAgICAvLyBBV1MgQXBwU3luY1xuICAgIGNvbnN0IGdyYXBocWwgPSBuZXcgR3JhcGhxbEFwaSh0aGlzLCBcImdyYXBocWxcIiwge1xuICAgICAgbmFtZTogaWQsXG4gICAgICBkZWZpbml0aW9uOiBEZWZpbml0aW9uLmZyb21GaWxlKHNjaGVtYSksXG4gICAgICBsb2dDb25maWc6IHtcbiAgICAgICAgZmllbGRMb2dMZXZlbDogRmllbGRMb2dMZXZlbC5FUlJPUixcbiAgICAgICAgcm9sZTogbmV3IGF3c19pYW0uUm9sZSh0aGlzLCBcImFwcHN5bmMtbG9nLXJvbGVcIiwge1xuICAgICAgICAgIGFzc3VtZWRCeTogbmV3IGF3c19pYW0uU2VydmljZVByaW5jaXBhbChcImFwcHN5bmMuYW1hem9uYXdzLmNvbVwiKSxcbiAgICAgICAgICBpbmxpbmVQb2xpY2llczoge1xuICAgICAgICAgICAgbG9nczogbmV3IGF3c19pYW0uUG9saWN5RG9jdW1lbnQoe1xuICAgICAgICAgICAgICBzdGF0ZW1lbnRzOiBbXG4gICAgICAgICAgICAgICAgbmV3IGF3c19pYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgICAgICAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgICAgICAgICAgICAgXCJsb2dzOkNyZWF0ZUxvZ0dyb3VwXCIsXG4gICAgICAgICAgICAgICAgICAgIFwibG9nczpDcmVhdGVMb2dTdHJlYW1cIixcbiAgICAgICAgICAgICAgICAgICAgXCJsb2dzOlB1dExvZ0V2ZW50c1wiLFxuICAgICAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgICAgIHJlc291cmNlczogW1xuICAgICAgICAgICAgICAgICAgICBgYXJuOmF3czpsb2dzOiR7U3RhY2sub2YodGhpcykucmVnaW9ufToke1xuICAgICAgICAgICAgICAgICAgICAgIFN0YWNrLm9mKHRoaXMpLmFjY291bnRcbiAgICAgICAgICAgICAgICAgICAgfWAsXG4gICAgICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgICAgIH0pLFxuICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgfSksXG4gICAgICAgICAgfSxcbiAgICAgICAgfSksXG4gICAgICB9LFxuICAgICAgYXV0aG9yaXphdGlvbkNvbmZpZzoge1xuICAgICAgICBkZWZhdWx0QXV0aG9yaXphdGlvbjoge1xuICAgICAgICAgIGF1dGhvcml6YXRpb25UeXBlOiBBdXRob3JpemF0aW9uVHlwZS5VU0VSX1BPT0wsXG4gICAgICAgICAgdXNlclBvb2xDb25maWc6IHtcbiAgICAgICAgICAgIHVzZXJQb29sOiBwcm9wcy5jb2duaXRvLnVzZXJQb29sLFxuICAgICAgICAgICAgYXBwSWRDbGllbnRSZWdleDogcHJvcHMuY29nbml0by5jb2duaXRvUGFyYW1zLnVzZXJQb29sQ2xpZW50SWQsXG4gICAgICAgICAgICBkZWZhdWx0QWN0aW9uOiBVc2VyUG9vbERlZmF1bHRBY3Rpb24uQUxMT1csXG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgICB4cmF5RW5hYmxlZDogdHJ1ZSxcbiAgICB9KTtcblxuICAgIHRoaXMuZ3JhcGhxbFVybCA9IGdyYXBocWwuZ3JhcGhxbFVybDtcblxuICAgIGNvbnN0IGxhbWJkYVJvbGUgPSBuZXcgYXdzX2lhbS5Sb2xlKHRoaXMsIFwibGFtYmRhUm9sZVwiLCB7XG4gICAgICBhc3N1bWVkQnk6IG5ldyBhd3NfaWFtLlNlcnZpY2VQcmluY2lwYWwoXCJsYW1iZGEuYW1hem9uYXdzLmNvbVwiKSxcbiAgICB9KTtcbiAgICBsYW1iZGFSb2xlLmFkZFRvUHJpbmNpcGFsUG9saWN5KFxuICAgICAgbmV3IGF3c19pYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgcmVzb3VyY2VzOiBbXCIqXCJdLFxuICAgICAgICBhY3Rpb25zOiBbXG4gICAgICAgICAgXCJsb2dzOkNyZWF0ZUxvZ0dyb3VwXCIsXG4gICAgICAgICAgXCJsb2dzOkNyZWF0ZUxvZ1N0cmVhbVwiLFxuICAgICAgICAgIFwibG9nczpQdXRMb2dFdmVudHNcIixcbiAgICAgICAgICBcImVjMjpDcmVhdGVOZXR3b3JrSW50ZXJmYWNlXCIsXG4gICAgICAgICAgXCJlYzI6RGVzY3JpYmVOZXR3b3JrSW50ZXJmYWNlc1wiLFxuICAgICAgICAgIFwiZWMyOkRlc2NyaWJlU3VibmV0c1wiLFxuICAgICAgICAgIFwiZWMyOkRlbGV0ZU5ldHdvcmtJbnRlcmZhY2VcIixcbiAgICAgICAgICBcImVjMjpBc3NpZ25Qcml2YXRlSXBBZGRyZXNzZXNcIixcbiAgICAgICAgICBcImVjMjpVbmFzc2lnblByaXZhdGVJcEFkZHJlc3Nlc1wiLFxuICAgICAgICBdLFxuICAgICAgfSlcbiAgICApO1xuICAgIGNsdXN0ZXIuZ3JhbnRDb25uZWN0KGxhbWJkYVJvbGUpO1xuXG4gICAgLy8gQVdTIExhbWJkYSBmb3IgZ3JhcGggYXBwbGljYXRpb25cbiAgICBjb25zdCBOb2RlanNGdW5jdGlvbkJhc2VQcm9wczogYXdzX2xhbWJkYV9ub2RlanMuTm9kZWpzRnVuY3Rpb25Qcm9wcyA9IHtcbiAgICAgIHJ1bnRpbWU6IGF3c19sYW1iZGEuUnVudGltZS5OT0RFSlNfMjBfWCxcblxuICAgICAgLy8gZW50cnk6IGAuL2FwaS9sYW1iZGEvJHtsYW1iZGFOYW1lfS50c2AsXG4gICAgICBkZXBzTG9ja0ZpbGVQYXRoOiBcIi4vYXBpL2xhbWJkYS9wYWNrYWdlLWxvY2suanNvblwiLFxuICAgICAgYXJjaGl0ZWN0dXJlOiBhd3NfbGFtYmRhLkFyY2hpdGVjdHVyZS5BUk1fNjQsXG4gICAgICB0aW1lb3V0OiBEdXJhdGlvbi5taW51dGVzKDEpLFxuICAgICAgcm9sZTogbGFtYmRhUm9sZSxcbiAgICAgIHZwYzogdnBjLFxuICAgICAgdnBjU3VibmV0czoge1xuICAgICAgICBzdWJuZXRzOiB2cGMuaXNvbGF0ZWRTdWJuZXRzLFxuICAgICAgfSxcbiAgICAgIGJ1bmRsaW5nOiB7XG4gICAgICAgIG5vZGVNb2R1bGVzOiBbXCJncmVtbGluXCIsIFwiZ3JlbWxpbi1hd3Mtc2lndjRcIl0sXG4gICAgICB9LFxuICAgIH07XG4gICAgY29uc3QgcXVlcnlGbiA9IG5ldyBhd3NfbGFtYmRhX25vZGVqcy5Ob2RlanNGdW5jdGlvbih0aGlzLCBcInF1ZXJ5Rm5cIiwge1xuICAgICAgLi4uTm9kZWpzRnVuY3Rpb25CYXNlUHJvcHMsXG4gICAgICBlbnRyeTogXCIuL2FwaS9sYW1iZGEvcXVlcnlHcmFwaC50c1wiLFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgTkVQVFVORV9FTkRQT0lOVDogY2x1c3Rlci5jbHVzdGVyUmVhZEVuZHBvaW50Lmhvc3RuYW1lLFxuICAgICAgICBORVBUVU5FX1BPUlQ6IGNsdXN0ZXIuY2x1c3RlclJlYWRFbmRwb2ludC5wb3J0LnRvU3RyaW5nKCksXG4gICAgICB9LFxuICAgIH0pO1xuICAgIGdyYXBocWwuZ3JhbnRRdWVyeShxdWVyeUZuKTtcbiAgICBxdWVyeUZuLmNvbm5lY3Rpb25zLmFsbG93VG8oY2x1c3RlciwgYXdzX2VjMi5Qb3J0LnRjcCg4MTgyKSk7XG5cbiAgICAvLyBBSSBRdWVyeSBMYW1iZGEgKEJlZHJvY2sgKyBOZXB0dW5lKVxuICAgIGNvbnN0IGFpUXVlcnlSb2xlID0gbmV3IGF3c19pYW0uUm9sZSh0aGlzLCBcImFpUXVlcnlSb2xlXCIsIHtcbiAgICAgIGFzc3VtZWRCeTogbmV3IGF3c19pYW0uU2VydmljZVByaW5jaXBhbChcImxhbWJkYS5hbWF6b25hd3MuY29tXCIpLFxuICAgIH0pO1xuICAgIGFpUXVlcnlSb2xlLmFkZFRvUHJpbmNpcGFsUG9saWN5KFxuICAgICAgbmV3IGF3c19pYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgcmVzb3VyY2VzOiBbXCIqXCJdLFxuICAgICAgICBhY3Rpb25zOiBbXG4gICAgICAgICAgXCJsb2dzOkNyZWF0ZUxvZ0dyb3VwXCIsXG4gICAgICAgICAgXCJsb2dzOkNyZWF0ZUxvZ1N0cmVhbVwiLFxuICAgICAgICAgIFwibG9nczpQdXRMb2dFdmVudHNcIixcbiAgICAgICAgICBcImVjMjpDcmVhdGVOZXR3b3JrSW50ZXJmYWNlXCIsXG4gICAgICAgICAgXCJlYzI6RGVzY3JpYmVOZXR3b3JrSW50ZXJmYWNlc1wiLFxuICAgICAgICAgIFwiZWMyOkRlc2NyaWJlU3VibmV0c1wiLFxuICAgICAgICAgIFwiZWMyOkRlbGV0ZU5ldHdvcmtJbnRlcmZhY2VcIixcbiAgICAgICAgICBcImVjMjpBc3NpZ25Qcml2YXRlSXBBZGRyZXNzZXNcIixcbiAgICAgICAgICBcImVjMjpVbmFzc2lnblByaXZhdGVJcEFkZHJlc3Nlc1wiLFxuICAgICAgICBdLFxuICAgICAgfSlcbiAgICApO1xuICAgIGFpUXVlcnlSb2xlLmFkZFRvUHJpbmNpcGFsUG9saWN5KFxuICAgICAgbmV3IGF3c19pYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgcmVzb3VyY2VzOiBbXG4gICAgICAgICAgYGFybjphd3M6YmVkcm9jazoke1N0YWNrLm9mKHRoaXMpLnJlZ2lvbn06OmZvdW5kYXRpb24tbW9kZWwvKmAsXG4gICAgICAgIF0sXG4gICAgICAgIGFjdGlvbnM6IFtcImJlZHJvY2s6SW52b2tlTW9kZWxcIl0sXG4gICAgICB9KVxuICAgICk7XG4gICAgY2x1c3Rlci5ncmFudENvbm5lY3QoYWlRdWVyeVJvbGUpO1xuXG4gICAgY29uc3QgYWlRdWVyeUZuID0gbmV3IGF3c19sYW1iZGFfbm9kZWpzLk5vZGVqc0Z1bmN0aW9uKFxuICAgICAgdGhpcyxcbiAgICAgIFwiYWlRdWVyeUZuXCIsXG4gICAgICB7XG4gICAgICAgIC4uLk5vZGVqc0Z1bmN0aW9uQmFzZVByb3BzLFxuICAgICAgICBlbnRyeTogXCIuL2FwaS9sYW1iZGEvYWlRdWVyeS50c1wiLFxuICAgICAgICByb2xlOiBhaVF1ZXJ5Um9sZSxcbiAgICAgICAgdGltZW91dDogRHVyYXRpb24ubWludXRlcygyKSxcbiAgICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgICBORVBUVU5FX0VORFBPSU5UOiBjbHVzdGVyLmNsdXN0ZXJSZWFkRW5kcG9pbnQuaG9zdG5hbWUsXG4gICAgICAgICAgTkVQVFVORV9QT1JUOiBjbHVzdGVyLmNsdXN0ZXJSZWFkRW5kcG9pbnQucG9ydC50b1N0cmluZygpLFxuICAgICAgICAgIEJFRFJPQ0tfUkVHSU9OOiBTdGFjay5vZih0aGlzKS5yZWdpb24sXG4gICAgICAgICAgTU9ERUxfSUQ6IFwiYW50aHJvcGljLmNsYXVkZS0zLWhhaWt1LTIwMjQwMzA3LXYxOjBcIixcbiAgICAgICAgfSxcbiAgICAgICAgYnVuZGxpbmc6IHtcbiAgICAgICAgICBub2RlTW9kdWxlczogW1xuICAgICAgICAgICAgXCJncmVtbGluXCIsXG4gICAgICAgICAgICBcImdyZW1saW4tYXdzLXNpZ3Y0XCIsXG4gICAgICAgICAgICBcIkBhd3Mtc2RrL2NsaWVudC1iZWRyb2NrLXJ1bnRpbWVcIixcbiAgICAgICAgICBdLFxuICAgICAgICB9LFxuICAgICAgICB2cGNTdWJuZXRzOiB7XG4gICAgICAgICAgc3VibmV0czogdnBjLmlzb2xhdGVkU3VibmV0cyxcbiAgICAgICAgfSxcbiAgICAgIH1cbiAgICApO1xuICAgIGdyYXBocWwuZ3JhbnRRdWVyeShhaVF1ZXJ5Rm4pO1xuICAgIGFpUXVlcnlGbi5jb25uZWN0aW9ucy5hbGxvd1RvKGNsdXN0ZXIsIGF3c19lYzIuUG9ydC50Y3AoODE4MikpO1xuXG4gICAgY29uc3QgbXV0YXRpb25GbiA9IG5ldyBhd3NfbGFtYmRhX25vZGVqcy5Ob2RlanNGdW5jdGlvbihcbiAgICAgIHRoaXMsXG4gICAgICBcIm11dGF0aW9uRm5cIixcbiAgICAgIHtcbiAgICAgICAgLi4uTm9kZWpzRnVuY3Rpb25CYXNlUHJvcHMsXG4gICAgICAgIGVudHJ5OiBcIi4vYXBpL2xhbWJkYS9tdXRhdGlvbkdyYXBoLnRzXCIsXG4gICAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgICAgTkVQVFVORV9FTkRQT0lOVDogY2x1c3Rlci5jbHVzdGVyRW5kcG9pbnQuaG9zdG5hbWUsXG4gICAgICAgICAgTkVQVFVORV9QT1JUOiBjbHVzdGVyLmNsdXN0ZXJFbmRwb2ludC5wb3J0LnRvU3RyaW5nKCksXG4gICAgICAgIH0sXG4gICAgICB9XG4gICAgKTtcbiAgICBncmFwaHFsLmdyYW50TXV0YXRpb24obXV0YXRpb25Gbik7XG4gICAgbXV0YXRpb25Gbi5jb25uZWN0aW9ucy5hbGxvd1RvKGNsdXN0ZXIsIGF3c19lYzIuUG9ydC50Y3AoODE4MikpO1xuXG4gICAgLy8gRnVuY3Rpb24gVVJMXG5cbiAgICBjb25zdCBidWxrTG9hZEZuID0gbmV3IGF3c19sYW1iZGFfbm9kZWpzLk5vZGVqc0Z1bmN0aW9uKFxuICAgICAgdGhpcyxcbiAgICAgIFwiYnVsa0xvYWRGblwiLFxuICAgICAge1xuICAgICAgICAuLi5Ob2RlanNGdW5jdGlvbkJhc2VQcm9wcyxcbiAgICAgICAgZW50cnk6IFwiLi9hcGkvbGFtYmRhL2Z1bmN0aW9uVXJsL2luZGV4LnRzXCIsXG4gICAgICAgIGRlcHNMb2NrRmlsZVBhdGg6IFwiLi9hcGkvbGFtYmRhL2Z1bmN0aW9uVXJsL3BhY2thZ2UtbG9jay5qc29uXCIsXG4gICAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgICAgTkVQVFVORV9FTkRQT0lOVDogY2x1c3Rlci5jbHVzdGVyRW5kcG9pbnQuaG9zdG5hbWUsXG4gICAgICAgICAgTkVQVFVORV9QT1JUOiBjbHVzdGVyLmNsdXN0ZXJFbmRwb2ludC5wb3J0LnRvU3RyaW5nKCksXG4gICAgICAgICAgVkVSVEVYOiBzM1VyaS52ZXJ0ZXgsXG4gICAgICAgICAgRURHRTogczNVcmkuZWRnZSxcbiAgICAgICAgICBST0xFX0FSTjogY2x1c3RlclJvbGUucm9sZUFybixcbiAgICAgICAgfSxcbiAgICAgICAgdnBjU3VibmV0czoge1xuICAgICAgICAgIHN1Ym5ldHM6IHZwYy5wdWJsaWNTdWJuZXRzLFxuICAgICAgICB9LFxuICAgICAgICBidW5kbGluZzoge1xuICAgICAgICAgIG5vZGVNb2R1bGVzOiBbXG4gICAgICAgICAgICBcIkBzbWl0aHkvc2lnbmF0dXJlLXY0XCIsXG4gICAgICAgICAgICBcIkBhd3Mtc2RrL2NyZWRlbnRpYWwtcHJvdmlkZXItbm9kZVwiLFxuICAgICAgICAgICAgXCJAYXdzLWNyeXB0by9zaGEyNTYtanNcIixcbiAgICAgICAgICAgIFwiQHNtaXRoeS9wcm90b2NvbC1odHRwXCIsXG4gICAgICAgICAgXSxcbiAgICAgICAgfSxcbiAgICAgICAgYWxsb3dQdWJsaWNTdWJuZXQ6IHRydWUsXG4gICAgICB9XG4gICAgKTtcbiAgICBidWxrTG9hZEZuLmNvbm5lY3Rpb25zLmFsbG93VG8oY2x1c3RlciwgYXdzX2VjMi5Qb3J0LnRjcCg4MTgyKSk7XG5cbiAgICBjb25zdCBmdW5jdGlvblVybCA9IGJ1bGtMb2FkRm4uYWRkRnVuY3Rpb25Vcmwoe1xuICAgICAgYXV0aFR5cGU6IGF3c19sYW1iZGEuRnVuY3Rpb25VcmxBdXRoVHlwZS5BV1NfSUFNLFxuICAgICAgY29yczoge1xuICAgICAgICBhbGxvd2VkTWV0aG9kczogW2F3c19sYW1iZGEuSHR0cE1ldGhvZC5HRVRdLFxuICAgICAgICBhbGxvd2VkT3JpZ2luczogW1wiKlwiXSxcbiAgICAgICAgYWxsb3dlZEhlYWRlcnM6IFtcIipcIl0sXG4gICAgICB9LFxuXG4gICAgICBpbnZva2VNb2RlOiBhd3NfbGFtYmRhLkludm9rZU1vZGUuUkVTUE9OU0VfU1RSRUFNLFxuICAgIH0pO1xuXG4gICAgZ3JhcGhxbEZpZWxkTmFtZS5tYXAoKGZpbGVkTmFtZTogc3RyaW5nKSA9PiB7XG4gICAgICAvLyBEYXRhIHNvdXJjZXNcbiAgICAgIGxldCB0YXJnZXRGbjtcbiAgICAgIGlmIChmaWxlZE5hbWUgPT09IFwiYXNrR3JhcGhcIikge1xuICAgICAgICB0YXJnZXRGbiA9IGFpUXVlcnlGbjtcbiAgICAgIH0gZWxzZSBpZiAoZmlsZWROYW1lLnN0YXJ0c1dpdGgoXCJnZXRcIikpIHtcbiAgICAgICAgdGFyZ2V0Rm4gPSBxdWVyeUZuO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGFyZ2V0Rm4gPSBtdXRhdGlvbkZuO1xuICAgICAgfVxuICAgICAgY29uc3QgZGF0YXNvdXJjZSA9IGdyYXBocWwuYWRkTGFtYmRhRGF0YVNvdXJjZShcbiAgICAgICAgYCR7ZmlsZWROYW1lfURTYCxcbiAgICAgICAgdGFyZ2V0Rm5cbiAgICAgICk7XG4gICAgICBxdWVyeUZuLmFkZEVudmlyb25tZW50KFwiR1JBUEhRTF9FTkRQT0lOVFwiLCB0aGlzLmdyYXBocWxVcmwpO1xuICAgICAgLy8gUmVzb2x2ZXJcbiAgICAgIGRhdGFzb3VyY2UuY3JlYXRlUmVzb2x2ZXIoYCR7ZmlsZWROYW1lfVJlc29sdmVyYCwge1xuICAgICAgICBmaWVsZE5hbWU6IGAke2ZpbGVkTmFtZX1gLFxuICAgICAgICB0eXBlTmFtZTogZmlsZWROYW1lLnN0YXJ0c1dpdGgoXCJnZXRcIikgfHwgZmlsZWROYW1lLnN0YXJ0c1dpdGgoXCJhc2tcIilcbiAgICAgICAgICA/IFwiUXVlcnlcIlxuICAgICAgICAgIDogXCJNdXRhdGlvblwiLFxuICAgICAgICByZXF1ZXN0TWFwcGluZ1RlbXBsYXRlOiBNYXBwaW5nVGVtcGxhdGUuZnJvbUZpbGUoXG4gICAgICAgICAgYC4vYXBpL2dyYXBocWwvcmVzb2x2ZXJzL3JlcXVlc3RzLyR7ZmlsZWROYW1lfS52dGxgXG4gICAgICAgICksXG4gICAgICAgIHJlc3BvbnNlTWFwcGluZ1RlbXBsYXRlOiBNYXBwaW5nVGVtcGxhdGUuZnJvbUZpbGUoXG4gICAgICAgICAgXCIuL2FwaS9ncmFwaHFsL3Jlc29sdmVycy9yZXNwb25zZXMvZGVmYXVsdC52dGxcIlxuICAgICAgICApLFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICAvLyBPdXRwdXRzXG4gICAgbmV3IENmbk91dHB1dCh0aGlzLCBcIkdyYXBocWxVcmxcIiwge1xuICAgICAgdmFsdWU6IHRoaXMuZ3JhcGhxbFVybCxcbiAgICB9KTtcbiAgICBuZXcgQ2ZuT3V0cHV0KHRoaXMsIFwiRnVuY3Rpb25VcmxcIiwge1xuICAgICAgdmFsdWU6IGZ1bmN0aW9uVXJsLnVybCxcbiAgICB9KTtcblxuICAgIC8vIFN1cHByZXNzaW9uc1xuICAgIE5hZ1N1cHByZXNzaW9ucy5hZGRSZXNvdXJjZVN1cHByZXNzaW9ucyhcbiAgICAgIGdyYXBocWwsXG4gICAgICBbXG4gICAgICAgIHtcbiAgICAgICAgICBpZDogXCJBd3NTb2x1dGlvbnMtSUFNNVwiLFxuICAgICAgICAgIHJlYXNvbjogXCJEYXRhc29yY2Ugcm9sZVwiLFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICAgIHRydWVcbiAgICApO1xuXG4gICAgTmFnU3VwcHJlc3Npb25zLmFkZFJlc291cmNlU3VwcHJlc3Npb25zKFxuICAgICAgbGFtYmRhUm9sZSxcbiAgICAgIFtcbiAgICAgICAge1xuICAgICAgICAgIGlkOiBcIkF3c1NvbHV0aW9ucy1JQU01XCIsXG4gICAgICAgICAgcmVhc29uOiBcIk5lZWQgdGhlIHBlcm1pc3Npb24gZm9yIGFjY2Vzc2luZyBkYXRhYmFzZSBpbiBWcGNcIixcbiAgICAgICAgfSxcbiAgICAgIF0sXG4gICAgICB0cnVlXG4gICAgKTtcbiAgICBOYWdTdXBwcmVzc2lvbnMuYWRkUmVzb3VyY2VTdXBwcmVzc2lvbnMoXG4gICAgICBhaVF1ZXJ5Um9sZSxcbiAgICAgIFtcbiAgICAgICAge1xuICAgICAgICAgIGlkOiBcIkF3c1NvbHV0aW9ucy1JQU01XCIsXG4gICAgICAgICAgcmVhc29uOiBcIk5lZWQgdGhlIHBlcm1pc3Npb24gZm9yIEJlZHJvY2sgYW5kIFZQQyBhY2Nlc3NcIixcbiAgICAgICAgfSxcbiAgICAgIF0sXG4gICAgICB0cnVlXG4gICAgKTtcbiAgICBOYWdTdXBwcmVzc2lvbnMuYWRkU3RhY2tTdXBwcmVzc2lvbnMoU3RhY2sub2YodGhpcyksIFtcbiAgICAgIHtcbiAgICAgICAgaWQ6IFwiQXdzU29sdXRpb25zLUlBTTRcIixcbiAgICAgICAgcmVhc29uOiBcIkNESyBtYW5hZ2VkIHJlc291cmNlXCIsXG4gICAgICAgIGFwcGxpZXNUbzogW1xuICAgICAgICAgIFwiUG9saWN5Ojphcm46PEFXUzo6UGFydGl0aW9uPjppYW06OmF3czpwb2xpY3kvc2VydmljZS1yb2xlL0FXU0xhbWJkYUJhc2ljRXhlY3V0aW9uUm9sZVwiLFxuICAgICAgICBdLFxuICAgICAgfSxcbiAgICAgIHtcbiAgICAgICAgaWQ6IFwiQXdzU29sdXRpb25zLUwxXCIsXG4gICAgICAgIHJlYXNvbjogXCJDREsgbWFuYWdlZCByZXNvdXJjZVwiLFxuICAgICAgfSxcbiAgICAgIHtcbiAgICAgICAgaWQ6IFwiQXdzU29sdXRpb25zLUlBTTVcIixcbiAgICAgICAgcmVhc29uOiBcIkNESyBtYW5hZ2VkIHJlc291cmNlXCIsXG4gICAgICAgIGFwcGxpZXNUbzogW1wiUmVzb3VyY2U6OipcIl0sXG4gICAgICB9LFxuICAgIF0pO1xuICB9XG59XG4iXX0=