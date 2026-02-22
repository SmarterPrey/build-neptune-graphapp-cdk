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
            actions: ["bedrock:InvokeModel", "bedrock:Converse"],
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
                MODEL_ID: "amazon.nova-lite-v1:0",
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXBpLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiYXBpLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7OztBQUFBLDZDQVFxQjtBQUNyQix5REFPaUM7QUFDakMsMkNBQXVDO0FBSXZDLHFDQUEwQztBQWtCMUMsTUFBYSxHQUFJLFNBQVEsc0JBQVM7SUFHaEMsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUFzQjtRQUM5RCxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBRWpCLE1BQU0sRUFBRSxNQUFNLEVBQUUsR0FBRyxFQUFFLE9BQU8sRUFBRSxXQUFXLEVBQUUsZ0JBQWdCLEVBQUUsS0FBSyxFQUFFLEdBQ2xFLEtBQUssQ0FBQztRQUVSLGNBQWM7UUFDZCxNQUFNLE9BQU8sR0FBRyxJQUFJLHdCQUFVLENBQUMsSUFBSSxFQUFFLFNBQVMsRUFBRTtZQUM5QyxJQUFJLEVBQUUsRUFBRTtZQUNSLFVBQVUsRUFBRSx3QkFBVSxDQUFDLFFBQVEsQ0FBQyxNQUFNLENBQUM7WUFDdkMsU0FBUyxFQUFFO2dCQUNULGFBQWEsRUFBRSwyQkFBYSxDQUFDLEtBQUs7Z0JBQ2xDLElBQUksRUFBRSxJQUFJLHFCQUFPLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxrQkFBa0IsRUFBRTtvQkFDL0MsU0FBUyxFQUFFLElBQUkscUJBQU8sQ0FBQyxnQkFBZ0IsQ0FBQyx1QkFBdUIsQ0FBQztvQkFDaEUsY0FBYyxFQUFFO3dCQUNkLElBQUksRUFBRSxJQUFJLHFCQUFPLENBQUMsY0FBYyxDQUFDOzRCQUMvQixVQUFVLEVBQUU7Z0NBQ1YsSUFBSSxxQkFBTyxDQUFDLGVBQWUsQ0FBQztvQ0FDMUIsT0FBTyxFQUFFO3dDQUNQLHFCQUFxQjt3Q0FDckIsc0JBQXNCO3dDQUN0QixtQkFBbUI7cUNBQ3BCO29DQUNELFNBQVMsRUFBRTt3Q0FDVCxnQkFBZ0IsbUJBQUssQ0FBQyxFQUFFLENBQUMsSUFBSSxDQUFDLENBQUMsTUFBTSxJQUNuQyxtQkFB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LEVBQUUsbUJBQW1CO2dCQUN2QixNQUFNLEVBQUUsbURBQW1EO2FBQzVEO1NBQ0YsRUFDRCxJQUFJLENBQ0wsQ0FBQztRQUNGLHlCQUFlLENBQUMsdUJBQXVCLENBQ3JDLFdBQVcsRUFDWDtZQUNFO2dCQUNFLEVBQUUsRUFBRSxtQkFBbUI7Z0JBQ3ZCLE1BQU0sRUFBRSxnREFBZ0Q7YUFDekQ7U0FDRixFQUNELElBQUksQ0FDTCxDQUFDO1FBQ0YseUJBQWUsQ0FBQyxvQkFBb0IsQ0FBQyxtQkFBSyxDQUFDLEVBQUUsQ0FBQyxJQUFJLENBQUMsRUFBRTtZQUNuRDtnQkFDRSxFQUFFLEVBQUUsbUJBQW1CO2dCQUN2QixNQUFNLEVBQUUsc0JBQXNCO2dCQUM5QixTQUFTLEVBQUU7b0JBQ1QsdUZBQXVGO2lCQUN4RjthQUNGO1lBQ0Q7Z0JBQ0UsRUFBRSxFQUFFLGlCQUFpQjtnQkFDckIsTUFBTSxFQUFFLHNCQUFzQjthQUMvQjtZQUNEO2dCQUNFLEVBQUUsRUFBRSxtQkFBbUI7Z0JBQ3ZCLE1BQU0sRUFBRSxzQkFBc0I7Z0JBQzlCLFNBQVMsRUFBRSxDQUFDLGFBQWEsQ0FBQzthQUMzQjtTQUNGLENBQUMsQ0FBQztJQUNMLENBQUM7Q0FDRjtBQW5URCxrQkFtVEMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQge1xuICBTdGFjayxcbiAgRHVyYXRpb24sXG4gIGF3c19lYzIsXG4gIGF3c19sYW1iZGFfbm9kZWpzLFxuICBhd3NfbGFtYmRhLFxuICBhd3NfaWFtLFxuICBDZm5PdXRwdXQsXG59IGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0IHtcbiAgQXV0aG9yaXphdGlvblR5cGUsXG4gIERlZmluaXRpb24sXG4gIEZpZWxkTG9nTGV2ZWwsXG4gIEdyYXBocWxBcGksXG4gIE1hcHBpbmdUZW1wbGF0ZSxcbiAgVXNlclBvb2xEZWZhdWx0QWN0aW9uLFxufSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWFwcHN5bmNcIjtcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gXCJjb25zdHJ1Y3RzXCI7XG5cbmltcG9ydCAqIGFzIG5lcHR1bmUgZnJvbSBcIkBhd3MtY2RrL2F3cy1uZXB0dW5lLWFscGhhXCI7XG5cbmltcG9ydCB7IE5hZ1N1cHByZXNzaW9ucyB9IGZyb20gXCJjZGstbmFnXCI7XG5pbXBvcnQgeyBDb2duaXRvIH0gZnJvbSBcIi4vY29nbml0b1wiO1xuXG5leHBvcnQgaW50ZXJmYWNlIEJhY2tlbmRBcGlQcm9wcyB7XG4gIHNjaGVtYTogc3RyaW5nO1xuICBjb2duaXRvOiBDb2duaXRvO1xuICB2cGM6IGF3c19lYzIuVnBjO1xuICBjbHVzdGVyOiBuZXB0dW5lLkRhdGFiYXNlQ2x1c3RlcjtcbiAgY2x1c3RlclJvbGU6IGF3c19pYW0uUm9sZTtcbiAgZ3JhcGhxbEZpZWxkTmFtZTogc3RyaW5nW107XG4gIHMzVXJpOiBTM1VyaTtcbn1cblxuZXhwb3J0IHR5cGUgUzNVcmkgPSB7XG4gIHZlcnRleDogc3RyaW5nO1xuICBlZGdlOiBzdHJpbmc7XG59O1xuXG5leHBvcnQgY2xhc3MgQXBpIGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgcmVhZG9ubHkgZ3JhcGhxbFVybDogc3RyaW5nO1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBCYWNrZW5kQXBpUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgY29uc3QgeyBzY2hlbWEsIHZwYywgY2x1c3RlciwgY2x1c3RlclJvbGUsIGdyYXBocWxGaWVsZE5hbWUsIHMzVXJpIH0gPVxuICAgICAgcHJvcHM7XG5cbiAgICAvLyBBV1MgQXBwU3luY1xuICAgIGNvbnN0IGdyYXBocWwgPSBuZXcgR3JhcGhxbEFwaSh0aGlzLCBcImdyYXBocWxcIiwge1xuICAgICAgbmFtZTogaWQsXG4gICAgICBkZWZpbml0aW9uOiBEZWZpbml0aW9uLmZyb21GaWxlKHNjaGVtYSksXG4gICAgICBsb2dDb25maWc6IHtcbiAgICAgICAgZmllbGRMb2dMZXZlbDogRmllbGRMb2dMZXZlbC5FUlJPUixcbiAgICAgICAgcm9sZTogbmV3IGF3c19pYW0uUm9sZSh0aGlzLCBcImFwcHN5bmMtbG9nLXJvbGVcIiwge1xuICAgICAgICAgIGFzc3VtZWRCeTogbmV3IGF3c19pYW0uU2VydmljZVByaW5jaXBhbChcImFwcHN5bmMuYW1hem9uYXdzLmNvbVwiKSxcbiAgICAgICAgICBpbmxpbmVQb2xpY2llczoge1xuICAgICAgICAgICAgbG9nczogbmV3IGF3c19pYW0uUG9saWN5RG9jdW1lbnQoe1xuICAgICAgICAgICAgICBzdGF0ZW1lbnRzOiBbXG4gICAgICAgICAgICAgICAgbmV3IGF3c19pYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgICAgICAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgICAgICAgICAgICAgXCJsb2dzOkNyZWF0ZUxvZ0dyb3VwXCIsXG4gICAgICAgICAgICAgICAgICAgIFwibG9nczpDcmVhdGVMb2dTdHJlYW1cIixcbiAgICAgICAgICAgICAgICAgICAgXCJsb2dzOlB1dExvZ0V2ZW50c1wiLFxuICAgICAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgICAgIHJlc291cmNlczogW1xuICAgICAgICAgICAgICAgICAgICBgYXJuOmF3czpsb2dzOiR7U3RhY2sub2YodGhpcykucmVnaW9ufToke1xuICAgICAgICAgICAgICAgICAgICAgIFN0YWNrLm9mKHRoaXMpLmFjY291bnRcbiAgICAgICAgICAgICAgICAgICAgfWAsXG4gICAgICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgICAgIH0pLFxuICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgfSksXG4gICAgICAgICAgfSxcbiAgICAgICAgfSksXG4gICAgICB9LFxuICAgICAgYXV0aG9yaXphdGlvbkNvbmZpZzoge1xuICAgICAgICBkZWZhdWx0QXV0aG9yaXphdGlvbjoge1xuICAgICAgICAgIGF1dGhvcml6YXRpb25UeXBlOiBBdXRob3JpemF0aW9uVHlwZS5VU0VSX1BPT0wsXG4gICAgICAgICAgdXNlclBvb2xDb25maWc6IHtcbiAgICAgICAgICAgIHVzZXJQb29sOiBwcm9wcy5jb2duaXRvLnVzZXJQb29sLFxuICAgICAgICAgICAgYXBwSWRDbGllbnRSZWdleDogcHJvcHMuY29nbml0by5jb2duaXRvUGFyYW1zLnVzZXJQb29sQ2xpZW50SWQsXG4gICAgICAgICAgICBkZWZhdWx0QWN0aW9uOiBVc2VyUG9vbERlZmF1bHRBY3Rpb24uQUxMT1csXG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgICB4cmF5RW5hYmxlZDogdHJ1ZSxcbiAgICB9KTtcblxuICAgIHRoaXMuZ3JhcGhxbFVybCA9IGdyYXBocWwuZ3JhcGhxbFVybDtcblxuICAgIGNvbnN0IGxhbWJkYVJvbGUgPSBuZXcgYXdzX2lhbS5Sb2xlKHRoaXMsIFwibGFtYmRhUm9sZVwiLCB7XG4gICAgICBhc3N1bWVkQnk6IG5ldyBhd3NfaWFtLlNlcnZpY2VQcmluY2lwYWwoXCJsYW1iZGEuYW1hem9uYXdzLmNvbVwiKSxcbiAgICB9KTtcbiAgICBsYW1iZGFSb2xlLmFkZFRvUHJpbmNpcGFsUG9saWN5KFxuICAgICAgbmV3IGF3c19pYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgcmVzb3VyY2VzOiBbXCIqXCJdLFxuICAgICAgICBhY3Rpb25zOiBbXG4gICAgICAgICAgXCJsb2dzOkNyZWF0ZUxvZ0dyb3VwXCIsXG4gICAgICAgICAgXCJsb2dzOkNyZWF0ZUxvZ1N0cmVhbVwiLFxuICAgICAgICAgIFwibG9nczpQdXRMb2dFdmVudHNcIixcbiAgICAgICAgICBcImVjMjpDcmVhdGVOZXR3b3JrSW50ZXJmYWNlXCIsXG4gICAgICAgICAgXCJlYzI6RGVzY3JpYmVOZXR3b3JrSW50ZXJmYWNlc1wiLFxuICAgICAgICAgIFwiZWMyOkRlc2NyaWJlU3VibmV0c1wiLFxuICAgICAgICAgIFwiZWMyOkRlbGV0ZU5ldHdvcmtJbnRlcmZhY2VcIixcbiAgICAgICAgICBcImVjMjpBc3NpZ25Qcml2YXRlSXBBZGRyZXNzZXNcIixcbiAgICAgICAgICBcImVjMjpVbmFzc2lnblByaXZhdGVJcEFkZHJlc3Nlc1wiLFxuICAgICAgICBdLFxuICAgICAgfSlcbiAgICApO1xuICAgIGNsdXN0ZXIuZ3JhbnRDb25uZWN0KGxhbWJkYVJvbGUpO1xuXG4gICAgLy8gQVdTIExhbWJkYSBmb3IgZ3JhcGggYXBwbGljYXRpb25cbiAgICBjb25zdCBOb2RlanNGdW5jdGlvbkJhc2VQcm9wczogYXdzX2xhbWJkYV9ub2RlanMuTm9kZWpzRnVuY3Rpb25Qcm9wcyA9IHtcbiAgICAgIHJ1bnRpbWU6IGF3c19sYW1iZGEuUnVudGltZS5OT0RFSlNfMjBfWCxcblxuICAgICAgLy8gZW50cnk6IGAuL2FwaS9sYW1iZGEvJHtsYW1iZGFOYW1lfS50c2AsXG4gICAgICBkZXBzTG9ja0ZpbGVQYXRoOiBcIi4vYXBpL2xhbWJkYS9wYWNrYWdlLWxvY2suanNvblwiLFxuICAgICAgYXJjaGl0ZWN0dXJlOiBhd3NfbGFtYmRhLkFyY2hpdGVjdHVyZS5BUk1fNjQsXG4gICAgICB0aW1lb3V0OiBEdXJhdGlvbi5taW51dGVzKDEpLFxuICAgICAgcm9sZTogbGFtYmRhUm9sZSxcbiAgICAgIHZwYzogdnBjLFxuICAgICAgdnBjU3VibmV0czoge1xuICAgICAgICBzdWJuZXRzOiB2cGMuaXNvbGF0ZWRTdWJuZXRzLFxuICAgICAgfSxcbiAgICAgIGJ1bmRsaW5nOiB7XG4gICAgICAgIG5vZGVNb2R1bGVzOiBbXCJncmVtbGluXCIsIFwiZ3JlbWxpbi1hd3Mtc2lndjRcIl0sXG4gICAgICB9LFxuICAgIH07XG4gICAgY29uc3QgcXVlcnlGbiA9IG5ldyBhd3NfbGFtYmRhX25vZGVqcy5Ob2RlanNGdW5jdGlvbih0aGlzLCBcInF1ZXJ5Rm5cIiwge1xuICAgICAgLi4uTm9kZWpzRnVuY3Rpb25CYXNlUHJvcHMsXG4gICAgICBlbnRyeTogXCIuL2FwaS9sYW1iZGEvcXVlcnlHcmFwaC50c1wiLFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgTkVQVFVORV9FTkRQT0lOVDogY2x1c3Rlci5jbHVzdGVyUmVhZEVuZHBvaW50Lmhvc3RuYW1lLFxuICAgICAgICBORVBUVU5FX1BPUlQ6IGNsdXN0ZXIuY2x1c3RlclJlYWRFbmRwb2ludC5wb3J0LnRvU3RyaW5nKCksXG4gICAgICB9LFxuICAgIH0pO1xuICAgIGdyYXBocWwuZ3JhbnRRdWVyeShxdWVyeUZuKTtcbiAgICBxdWVyeUZuLmNvbm5lY3Rpb25zLmFsbG93VG8oY2x1c3RlciwgYXdzX2VjMi5Qb3J0LnRjcCg4MTgyKSk7XG5cbiAgICAvLyBBSSBRdWVyeSBMYW1iZGEgKEJlZHJvY2sgKyBOZXB0dW5lKVxuICAgIGNvbnN0IGFpUXVlcnlSb2xlID0gbmV3IGF3c19pYW0uUm9sZSh0aGlzLCBcImFpUXVlcnlSb2xlXCIsIHtcbiAgICAgIGFzc3VtZWRCeTogbmV3IGF3c19pYW0uU2VydmljZVByaW5jaXBhbChcImxhbWJkYS5hbWF6b25hd3MuY29tXCIpLFxuICAgIH0pO1xuICAgIGFpUXVlcnlSb2xlLmFkZFRvUHJpbmNpcGFsUG9saWN5KFxuICAgICAgbmV3IGF3c19pYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgcmVzb3VyY2VzOiBbXCIqXCJdLFxuICAgICAgICBhY3Rpb25zOiBbXG4gICAgICAgICAgXCJsb2dzOkNyZWF0ZUxvZ0dyb3VwXCIsXG4gICAgICAgICAgXCJsb2dzOkNyZWF0ZUxvZ1N0cmVhbVwiLFxuICAgICAgICAgIFwibG9nczpQdXRMb2dFdmVudHNcIixcbiAgICAgICAgICBcImVjMjpDcmVhdGVOZXR3b3JrSW50ZXJmYWNlXCIsXG4gICAgICAgICAgXCJlYzI6RGVzY3JpYmVOZXR3b3JrSW50ZXJmYWNlc1wiLFxuICAgICAgICAgIFwiZWMyOkRlc2NyaWJlU3VibmV0c1wiLFxuICAgICAgICAgIFwiZWMyOkRlbGV0ZU5ldHdvcmtJbnRlcmZhY2VcIixcbiAgICAgICAgICBcImVjMjpBc3NpZ25Qcml2YXRlSXBBZGRyZXNzZXNcIixcbiAgICAgICAgICBcImVjMjpVbmFzc2lnblByaXZhdGVJcEFkZHJlc3Nlc1wiLFxuICAgICAgICBdLFxuICAgICAgfSlcbiAgICApO1xuICAgIGFpUXVlcnlSb2xlLmFkZFRvUHJpbmNpcGFsUG9saWN5KFxuICAgICAgbmV3IGF3c19pYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgcmVzb3VyY2VzOiBbXG4gICAgICAgICAgYGFybjphd3M6YmVkcm9jazoke1N0YWNrLm9mKHRoaXMpLnJlZ2lvbn06OmZvdW5kYXRpb24tbW9kZWwvKmAsXG4gICAgICAgIF0sXG4gICAgICAgIGFjdGlvbnM6IFtcImJlZHJvY2s6SW52b2tlTW9kZWxcIiwgXCJiZWRyb2NrOkNvbnZlcnNlXCJdLFxuICAgICAgfSlcbiAgICApO1xuICAgIGNsdXN0ZXIuZ3JhbnRDb25uZWN0KGFpUXVlcnlSb2xlKTtcblxuICAgIGNvbnN0IGFpUXVlcnlGbiA9IG5ldyBhd3NfbGFtYmRhX25vZGVqcy5Ob2RlanNGdW5jdGlvbihcbiAgICAgIHRoaXMsXG4gICAgICBcImFpUXVlcnlGblwiLFxuICAgICAge1xuICAgICAgICAuLi5Ob2RlanNGdW5jdGlvbkJhc2VQcm9wcyxcbiAgICAgICAgZW50cnk6IFwiLi9hcGkvbGFtYmRhL2FpUXVlcnkudHNcIixcbiAgICAgICAgcm9sZTogYWlRdWVyeVJvbGUsXG4gICAgICAgIHRpbWVvdXQ6IER1cmF0aW9uLm1pbnV0ZXMoMiksXG4gICAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgICAgTkVQVFVORV9FTkRQT0lOVDogY2x1c3Rlci5jbHVzdGVyUmVhZEVuZHBvaW50Lmhvc3RuYW1lLFxuICAgICAgICAgIE5FUFRVTkVfUE9SVDogY2x1c3Rlci5jbHVzdGVyUmVhZEVuZHBvaW50LnBvcnQudG9TdHJpbmcoKSxcbiAgICAgICAgICBCRURST0NLX1JFR0lPTjogU3RhY2sub2YodGhpcykucmVnaW9uLFxuICAgICAgICAgIE1PREVMX0lEOiBcImFtYXpvbi5ub3ZhLWxpdGUtdjE6MFwiLFxuICAgICAgICB9LFxuICAgICAgICBidW5kbGluZzoge1xuICAgICAgICAgIG5vZGVNb2R1bGVzOiBbXG4gICAgICAgICAgICBcImdyZW1saW5cIixcbiAgICAgICAgICAgIFwiZ3JlbWxpbi1hd3Mtc2lndjRcIixcbiAgICAgICAgICAgIFwiQGF3cy1zZGsvY2xpZW50LWJlZHJvY2stcnVudGltZVwiLFxuICAgICAgICAgIF0sXG4gICAgICAgIH0sXG4gICAgICAgIHZwY1N1Ym5ldHM6IHtcbiAgICAgICAgICBzdWJuZXRzOiB2cGMuaXNvbGF0ZWRTdWJuZXRzLFxuICAgICAgICB9LFxuICAgICAgfVxuICAgICk7XG4gICAgZ3JhcGhxbC5ncmFudFF1ZXJ5KGFpUXVlcnlGbik7XG4gICAgYWlRdWVyeUZuLmNvbm5lY3Rpb25zLmFsbG93VG8oY2x1c3RlciwgYXdzX2VjMi5Qb3J0LnRjcCg4MTgyKSk7XG5cbiAgICBjb25zdCBtdXRhdGlvbkZuID0gbmV3IGF3c19sYW1iZGFfbm9kZWpzLk5vZGVqc0Z1bmN0aW9uKFxuICAgICAgdGhpcyxcbiAgICAgIFwibXV0YXRpb25GblwiLFxuICAgICAge1xuICAgICAgICAuLi5Ob2RlanNGdW5jdGlvbkJhc2VQcm9wcyxcbiAgICAgICAgZW50cnk6IFwiLi9hcGkvbGFtYmRhL211dGF0aW9uR3JhcGgudHNcIixcbiAgICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgICBORVBUVU5FX0VORFBPSU5UOiBjbHVzdGVyLmNsdXN0ZXJFbmRwb2ludC5ob3N0bmFtZSxcbiAgICAgICAgICBORVBUVU5FX1BPUlQ6IGNsdXN0ZXIuY2x1c3RlckVuZHBvaW50LnBvcnQudG9TdHJpbmcoKSxcbiAgICAgICAgfSxcbiAgICAgIH1cbiAgICApO1xuICAgIGdyYXBocWwuZ3JhbnRNdXRhdGlvbihtdXRhdGlvbkZuKTtcbiAgICBtdXRhdGlvbkZuLmNvbm5lY3Rpb25zLmFsbG93VG8oY2x1c3RlciwgYXdzX2VjMi5Qb3J0LnRjcCg4MTgyKSk7XG5cbiAgICAvLyBGdW5jdGlvbiBVUkxcblxuICAgIGNvbnN0IGJ1bGtMb2FkRm4gPSBuZXcgYXdzX2xhbWJkYV9ub2RlanMuTm9kZWpzRnVuY3Rpb24oXG4gICAgICB0aGlzLFxuICAgICAgXCJidWxrTG9hZEZuXCIsXG4gICAgICB7XG4gICAgICAgIC4uLk5vZGVqc0Z1bmN0aW9uQmFzZVByb3BzLFxuICAgICAgICBlbnRyeTogXCIuL2FwaS9sYW1iZGEvZnVuY3Rpb25VcmwvaW5kZXgudHNcIixcbiAgICAgICAgZGVwc0xvY2tGaWxlUGF0aDogXCIuL2FwaS9sYW1iZGEvZnVuY3Rpb25VcmwvcGFja2FnZS1sb2NrLmpzb25cIixcbiAgICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgICBORVBUVU5FX0VORFBPSU5UOiBjbHVzdGVyLmNsdXN0ZXJFbmRwb2ludC5ob3N0bmFtZSxcbiAgICAgICAgICBORVBUVU5FX1BPUlQ6IGNsdXN0ZXIuY2x1c3RlckVuZHBvaW50LnBvcnQudG9TdHJpbmcoKSxcbiAgICAgICAgICBWRVJURVg6IHMzVXJpLnZlcnRleCxcbiAgICAgICAgICBFREdFOiBzM1VyaS5lZGdlLFxuICAgICAgICAgIFJPTEVfQVJOOiBjbHVzdGVyUm9sZS5yb2xlQXJuLFxuICAgICAgICB9LFxuICAgICAgICB2cGNTdWJuZXRzOiB7XG4gICAgICAgICAgc3VibmV0czogdnBjLnB1YmxpY1N1Ym5ldHMsXG4gICAgICAgIH0sXG4gICAgICAgIGJ1bmRsaW5nOiB7XG4gICAgICAgICAgbm9kZU1vZHVsZXM6IFtcbiAgICAgICAgICAgIFwiQHNtaXRoeS9zaWduYXR1cmUtdjRcIixcbiAgICAgICAgICAgIFwiQGF3cy1zZGsvY3JlZGVudGlhbC1wcm92aWRlci1ub2RlXCIsXG4gICAgICAgICAgICBcIkBhd3MtY3J5cHRvL3NoYTI1Ni1qc1wiLFxuICAgICAgICAgICAgXCJAc21pdGh5L3Byb3RvY29sLWh0dHBcIixcbiAgICAgICAgICBdLFxuICAgICAgICB9LFxuICAgICAgICBhbGxvd1B1YmxpY1N1Ym5ldDogdHJ1ZSxcbiAgICAgIH1cbiAgICApO1xuICAgIGJ1bGtMb2FkRm4uY29ubmVjdGlvbnMuYWxsb3dUbyhjbHVzdGVyLCBhd3NfZWMyLlBvcnQudGNwKDgxODIpKTtcblxuICAgIGNvbnN0IGZ1bmN0aW9uVXJsID0gYnVsa0xvYWRGbi5hZGRGdW5jdGlvblVybCh7XG4gICAgICBhdXRoVHlwZTogYXdzX2xhbWJkYS5GdW5jdGlvblVybEF1dGhUeXBlLkFXU19JQU0sXG4gICAgICBjb3JzOiB7XG4gICAgICAgIGFsbG93ZWRNZXRob2RzOiBbYXdzX2xhbWJkYS5IdHRwTWV0aG9kLkdFVF0sXG4gICAgICAgIGFsbG93ZWRPcmlnaW5zOiBbXCIqXCJdLFxuICAgICAgICBhbGxvd2VkSGVhZGVyczogW1wiKlwiXSxcbiAgICAgIH0sXG5cbiAgICAgIGludm9rZU1vZGU6IGF3c19sYW1iZGEuSW52b2tlTW9kZS5SRVNQT05TRV9TVFJFQU0sXG4gICAgfSk7XG5cbiAgICBncmFwaHFsRmllbGROYW1lLm1hcCgoZmlsZWROYW1lOiBzdHJpbmcpID0+IHtcbiAgICAgIC8vIERhdGEgc291cmNlc1xuICAgICAgbGV0IHRhcmdldEZuO1xuICAgICAgaWYgKGZpbGVkTmFtZSA9PT0gXCJhc2tHcmFwaFwiKSB7XG4gICAgICAgIHRhcmdldEZuID0gYWlRdWVyeUZuO1xuICAgICAgfSBlbHNlIGlmIChmaWxlZE5hbWUuc3RhcnRzV2l0aChcImdldFwiKSkge1xuICAgICAgICB0YXJnZXRGbiA9IHF1ZXJ5Rm47XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0YXJnZXRGbiA9IG11dGF0aW9uRm47XG4gICAgICB9XG4gICAgICBjb25zdCBkYXRhc291cmNlID0gZ3JhcGhxbC5hZGRMYW1iZGFEYXRhU291cmNlKFxuICAgICAgICBgJHtmaWxlZE5hbWV9RFNgLFxuICAgICAgICB0YXJnZXRGblxuICAgICAgKTtcbiAgICAgIHF1ZXJ5Rm4uYWRkRW52aXJvbm1lbnQoXCJHUkFQSFFMX0VORFBPSU5UXCIsIHRoaXMuZ3JhcGhxbFVybCk7XG4gICAgICAvLyBSZXNvbHZlclxuICAgICAgZGF0YXNvdXJjZS5jcmVhdGVSZXNvbHZlcihgJHtmaWxlZE5hbWV9UmVzb2x2ZXJgLCB7XG4gICAgICAgIGZpZWxkTmFtZTogYCR7ZmlsZWROYW1lfWAsXG4gICAgICAgIHR5cGVOYW1lOiBmaWxlZE5hbWUuc3RhcnRzV2l0aChcImdldFwiKSB8fCBmaWxlZE5hbWUuc3RhcnRzV2l0aChcImFza1wiKVxuICAgICAgICAgID8gXCJRdWVyeVwiXG4gICAgICAgICAgOiBcIk11dGF0aW9uXCIsXG4gICAgICAgIHJlcXVlc3RNYXBwaW5nVGVtcGxhdGU6IE1hcHBpbmdUZW1wbGF0ZS5mcm9tRmlsZShcbiAgICAgICAgICBgLi9hcGkvZ3JhcGhxbC9yZXNvbHZlcnMvcmVxdWVzdHMvJHtmaWxlZE5hbWV9LnZ0bGBcbiAgICAgICAgKSxcbiAgICAgICAgcmVzcG9uc2VNYXBwaW5nVGVtcGxhdGU6IE1hcHBpbmdUZW1wbGF0ZS5mcm9tRmlsZShcbiAgICAgICAgICBcIi4vYXBpL2dyYXBocWwvcmVzb2x2ZXJzL3Jlc3BvbnNlcy9kZWZhdWx0LnZ0bFwiXG4gICAgICAgICksXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIC8vIE91dHB1dHNcbiAgICBuZXcgQ2ZuT3V0cHV0KHRoaXMsIFwiR3JhcGhxbFVybFwiLCB7XG4gICAgICB2YWx1ZTogdGhpcy5ncmFwaHFsVXJsLFxuICAgIH0pO1xuICAgIG5ldyBDZm5PdXRwdXQodGhpcywgXCJGdW5jdGlvblVybFwiLCB7XG4gICAgICB2YWx1ZTogZnVuY3Rpb25VcmwudXJsLFxuICAgIH0pO1xuXG4gICAgLy8gU3VwcHJlc3Npb25zXG4gICAgTmFnU3VwcHJlc3Npb25zLmFkZFJlc291cmNlU3VwcHJlc3Npb25zKFxuICAgICAgZ3JhcGhxbCxcbiAgICAgIFtcbiAgICAgICAge1xuICAgICAgICAgIGlkOiBcIkF3c1NvbHV0aW9ucy1JQU01XCIsXG4gICAgICAgICAgcmVhc29uOiBcIkRhdGFzb3JjZSByb2xlXCIsXG4gICAgICAgIH0sXG4gICAgICBdLFxuICAgICAgdHJ1ZVxuICAgICk7XG5cbiAgICBOYWdTdXBwcmVzc2lvbnMuYWRkUmVzb3VyY2VTdXBwcmVzc2lvbnMoXG4gICAgICBsYW1iZGFSb2xlLFxuICAgICAgW1xuICAgICAgICB7XG4gICAgICAgICAgaWQ6IFwiQXdzU29sdXRpb25zLUlBTTVcIixcbiAgICAgICAgICByZWFzb246IFwiTmVlZCB0aGUgcGVybWlzc2lvbiBmb3IgYWNjZXNzaW5nIGRhdGFiYXNlIGluIFZwY1wiLFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICAgIHRydWVcbiAgICApO1xuICAgIE5hZ1N1cHByZXNzaW9ucy5hZGRSZXNvdXJjZVN1cHByZXNzaW9ucyhcbiAgICAgIGFpUXVlcnlSb2xlLFxuICAgICAgW1xuICAgICAgICB7XG4gICAgICAgICAgaWQ6IFwiQXdzU29sdXRpb25zLUlBTTVcIixcbiAgICAgICAgICByZWFzb246IFwiTmVlZCB0aGUgcGVybWlzc2lvbiBmb3IgQmVkcm9jayBhbmQgVlBDIGFjY2Vzc1wiLFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICAgIHRydWVcbiAgICApO1xuICAgIE5hZ1N1cHByZXNzaW9ucy5hZGRTdGFja1N1cHByZXNzaW9ucyhTdGFjay5vZih0aGlzKSwgW1xuICAgICAge1xuICAgICAgICBpZDogXCJBd3NTb2x1dGlvbnMtSUFNNFwiLFxuICAgICAgICByZWFzb246IFwiQ0RLIG1hbmFnZWQgcmVzb3VyY2VcIixcbiAgICAgICAgYXBwbGllc1RvOiBbXG4gICAgICAgICAgXCJQb2xpY3k6OmFybjo8QVdTOjpQYXJ0aXRpb24+OmlhbTo6YXdzOnBvbGljeS9zZXJ2aWNlLXJvbGUvQVdTTGFtYmRhQmFzaWNFeGVjdXRpb25Sb2xlXCIsXG4gICAgICAgIF0sXG4gICAgICB9LFxuICAgICAge1xuICAgICAgICBpZDogXCJBd3NTb2x1dGlvbnMtTDFcIixcbiAgICAgICAgcmVhc29uOiBcIkNESyBtYW5hZ2VkIHJlc291cmNlXCIsXG4gICAgICB9LFxuICAgICAge1xuICAgICAgICBpZDogXCJBd3NTb2x1dGlvbnMtSUFNNVwiLFxuICAgICAgICByZWFzb246IFwiQ0RLIG1hbmFnZWQgcmVzb3VyY2VcIixcbiAgICAgICAgYXBwbGllc1RvOiBbXCJSZXNvdXJjZTo6KlwiXSxcbiAgICAgIH0sXG4gICAgXSk7XG4gIH1cbn1cbiJdfQ==