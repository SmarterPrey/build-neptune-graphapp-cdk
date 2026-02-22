"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Cognito = void 0;
const constructs_1 = require("constructs");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const custom_resources_1 = require("aws-cdk-lib/custom-resources");
const aws_cognito_identitypool_1 = require("aws-cdk-lib/aws-cognito-identitypool");
const cdk_nag_1 = require("cdk-nag");
class Cognito extends constructs_1.Construct {
    constructor(scope, id, props) {
        super(scope, id);
        if (!props.userName)
            props.userName = props.adminEmail.split("@")[0];
        this.userPool = new aws_cdk_lib_1.aws_cognito.UserPool(this, "userpool", {
            userPoolName: `${id}-app-userpool`,
            signInAliases: {
                username: true,
                email: true,
            },
            accountRecovery: aws_cdk_lib_1.aws_cognito.AccountRecovery.EMAIL_ONLY,
            removalPolicy: aws_cdk_lib_1.RemovalPolicy.DESTROY,
            selfSignUpEnabled: false,
            // advancedSecurityMode is deprecated. Use StandardThreatProtectionMode and CustomThreatProtectionMode instead.
            standardThreatProtectionMode: aws_cdk_lib_1.aws_cognito.StandardThreatProtectionMode.FULL_FUNCTION,
            // customThreatProtectionMode: aws_cognito.CustomThreatProtectionMode.ENABLED, // Uncomment and configure as needed
            autoVerify: {
                email: true,
            },
            passwordPolicy: {
                minLength: 8,
                requireUppercase: true,
                requireDigits: true,
                requireSymbols: true,
            },
        });
        const userPoolClient = this.userPool.addClient("webappClient", {
            authFlows: {
                userSrp: true,
                adminUserPassword: true,
            },
            preventUserExistenceErrors: true,
            refreshTokenValidity: props.refreshTokenValidity,
        });
        const identityPool = new aws_cognito_identitypool_1.IdentityPool(this, "identityPool", {
            allowUnauthenticatedIdentities: false,
            authenticationProviders: {
                userPools: [
                    new aws_cognito_identitypool_1.UserPoolAuthenticationProvider({
                        userPool: this.userPool,
                        userPoolClient,
                    }),
                ],
            },
        });
        new CreatePoolUser(this, "admin-user", {
            email: props.adminEmail,
            username: props.userName,
            userPool: this.userPool,
        });
        this.cognitoParams = {
            userPoolId: this.userPool.userPoolId,
            userPoolClientId: userPoolClient.userPoolClientId,
            identityPoolId: identityPool.identityPoolId,
        };
        new aws_cdk_lib_1.CfnOutput(this, "UserPoolId", {
            value: this.userPool.userPoolId,
        });
        new aws_cdk_lib_1.CfnOutput(this, "UserPoolClientId", {
            value: userPoolClient.userPoolClientId,
        });
        new aws_cdk_lib_1.CfnOutput(this, "IdentityPoolId", {
            value: identityPool.identityPoolId,
        });
        // Suppressions
        cdk_nag_1.NagSuppressions.addResourceSuppressions(this.userPool, [
            {
                id: "AwsSolutions-COG2",
                reason: "No need MFA for sample",
            },
        ]);
    }
}
exports.Cognito = Cognito;
class CreatePoolUser extends constructs_1.Construct {
    constructor(scope, id, props) {
        super(scope, id);
        const statement = new aws_cdk_lib_1.aws_iam.PolicyStatement({
            actions: ["cognito-idp:AdminDeleteUser", "cognito-idp:AdminCreateUser"],
            resources: [props.userPool.userPoolArn],
        });
        new custom_resources_1.AwsCustomResource(this, `CreateUser-${id}`, {
            onCreate: {
                service: "CognitoIdentityServiceProvider",
                action: "adminCreateUser",
                parameters: {
                    UserPoolId: props.userPool.userPoolId,
                    Username: props.username,
                    UserAttributes: [
                        {
                            Name: "email",
                            Value: props.email,
                        },
                        {
                            Name: "email_verified",
                            Value: "true",
                        },
                    ],
                },
                physicalResourceId: custom_resources_1.PhysicalResourceId.of(`CreateUser-${id}-${props.username}`),
            },
            onDelete: {
                service: "CognitoIdentityServiceProvider",
                action: "adminDeleteUser",
                parameters: {
                    UserPoolId: props.userPool.userPoolId,
                    Username: props.username,
                },
            },
            policy: custom_resources_1.AwsCustomResourcePolicy.fromStatements([statement]),
        });
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY29nbml0by5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImNvZ25pdG8udHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBQUEsMkNBQXVDO0FBQ3ZDLDZDQU1xQjtBQUVyQixtRUFJc0M7QUFFdEMsbUZBRzhDO0FBQzlDLHFDQUEwQztBQWMxQyxNQUFhLE9BQVEsU0FBUSxzQkFBUztJQUdwQyxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQW1CO1FBQzNELEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFFakIsSUFBSSxDQUFDLEtBQUssQ0FBQyxRQUFRO1lBQUUsS0FBSyxDQUFDLFFBQVEsR0FBRyxLQUFLLENBQUMsVUFBVSxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztRQUVyRSxJQUFJLENBQUMsUUFBUSxHQUFHLElBQUkseUJBQVcsQ0FBQyxRQUFRLENBQUMsSUFBSSxFQUFFLFVBQVUsRUFBRTtZQUN6RCxZQUFZLEVBQUUsR0FBRyxFQUFFLGVBQWU7WUFDbEMsYUFBYSxFQUFFO2dCQUNiLFFBQVEsRUFBRSxJQUFJO2dCQUNkLEtBQUssRUFBRSxJQUFJO2FBQ1o7WUFDRCxlQUFlLEVBQUUseUJBQVcsQ0FBQyxlQUFlLENBQUMsVUFBVTtZQUN2RCxhQUFhLEVBQUUsMkJBQWEsQ0FBQyxPQUFPO1lBQ3BDLGlCQUFpQixFQUFFLEtBQUs7WUFDeEIsK0dBQStHO1lBQy9HLDRCQUE0QixFQUFFLHlCQUFXLENBQUMsNEJBQTRCLENBQUMsYUFBYTtZQUNwRixtSEFBbUg7WUFDbkgsVUFBVSxFQUFFO2dCQUNWLEtBQUssRUFBRSxJQUFJO2FBQ1o7WUFDRCxjQUFjLEVBQUU7Z0JBQ2QsU0FBUyxFQUFFLENBQUM7Z0JBQ1osZ0JBQWdCLEVBQUUsSUFBSTtnQkFDdEIsYUFBYSxFQUFFLElBQUk7Z0JBQ25CLGNBQWMsRUFBRSxJQUFJO2FBQ3JCO1NBQ0YsQ0FBQyxDQUFDO1FBRUgsTUFBTSxjQUFj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RUFBRSxJQUFJLEtBQUssQ0FBQyxRQUFRLEVBQUUsQ0FDckM7YUFDRjtZQUNELFFBQVEsRUFBRTtnQkFDUixPQUFPLEVBQUUsZ0NBQWdDO2dCQUN6QyxNQUFNLEVBQUUsaUJBQWlCO2dCQUN6QixVQUFVLEVBQUU7b0JBQ1YsVUFBVSxFQUFFLEtBQUssQ0FBQyxRQUFRLENBQUMsVUFBVTtvQkFDckMsUUFBUSxFQUFFLEtBQUssQ0FBQyxRQUFRO2lCQUN6QjthQUNGO1lBQ0QsTUFBTSxFQUFFLDBDQUF1QixDQUFDLGNBQWMsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxDQUFDO1NBQzVELENBQUMsQ0FBQztJQUNMLENBQUM7Q0FDRiIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gXCJjb25zdHJ1Y3RzXCI7XG5pbXBvcnQge1xuICBEdXJhdGlvbixcbiAgUmVtb3ZhbFBvbGljeSxcbiAgYXdzX2NvZ25pdG8sXG4gIGF3c19pYW0sXG4gIENmbk91dHB1dCxcbn0gZnJvbSBcImF3cy1jZGstbGliXCI7XG5cbmltcG9ydCB7XG4gIEF3c0N1c3RvbVJlc291cmNlLFxuICBBd3NDdXN0b21SZXNvdXJjZVBvbGljeSxcbiAgUGh5c2ljYWxSZXNvdXJjZUlkLFxufSBmcm9tIFwiYXdzLWNkay1saWIvY3VzdG9tLXJlc291cmNlc1wiO1xuXG5pbXBvcnQge1xuICBJZGVudGl0eVBvb2wsXG4gIFVzZXJQb29sQXV0aGVudGljYXRpb25Qcm92aWRlcixcbn0gZnJvbSBcImF3cy1jZGstbGliL2F3cy1jb2duaXRvLWlkZW50aXR5cG9vbFwiO1xuaW1wb3J0IHsgTmFnU3VwcHJlc3Npb25zIH0gZnJvbSBcImNkay1uYWdcIjtcblxuZXhwb3J0IGludGVyZmFjZSBDb2duaXRvUHJvcHMge1xuICBhZG1pbkVtYWlsOiBzdHJpbmc7XG4gIHVzZXJOYW1lPzogc3RyaW5nO1xuICByZWZyZXNoVG9rZW5WYWxpZGl0eT86IER1cmF0aW9uO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIENvZ25pdG9QYXJhbXMge1xuICB1c2VyUG9vbElkOiBzdHJpbmc7XG4gIHVzZXJQb29sQ2xpZW50SWQ6IHN0cmluZztcbiAgaWRlbnRpdHlQb29sSWQ6IHN0cmluZztcbn1cblxuZXhwb3J0IGNsYXNzIENvZ25pdG8gZXh0ZW5kcyBDb25zdHJ1Y3Qge1xuICBwdWJsaWMgcmVhZG9ubHkgY29nbml0b1BhcmFtczogQ29nbml0b1BhcmFtcztcbiAgcHVibGljIHJlYWRvbmx5IHVzZXJQb29sOiBhd3NfY29nbml0by5Vc2VyUG9vbDtcbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IENvZ25pdG9Qcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCk7XG5cbiAgICBpZiAoIXByb3BzLnVzZXJOYW1lKSBwcm9wcy51c2VyTmFtZSA9IHByb3BzLmFkbWluRW1haWwuc3BsaXQoXCJAXCIpWzBdO1xuXG4gICAgdGhpcy51c2VyUG9vbCA9IG5ldyBhd3NfY29nbml0by5Vc2VyUG9vbCh0aGlzLCBcInVzZXJwb29sXCIsIHtcbiAgICAgIHVzZXJQb29sTmFtZTogYCR7aWR9LWFwcC11c2VycG9vbGAsXG4gICAgICBzaWduSW5BbGlhc2VzOiB7XG4gICAgICAgIHVzZXJuYW1lOiB0cnVlLFxuICAgICAgICBlbWFpbDogdHJ1ZSxcbiAgICAgIH0sXG4gICAgICBhY2NvdW50UmVjb3Zlcnk6IGF3c19jb2duaXRvLkFjY291bnRSZWNvdmVyeS5FTUFJTF9PTkxZLFxuICAgICAgcmVtb3ZhbFBvbGljeTogUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgICAgc2VsZlNpZ25VcEVuYWJsZWQ6IGZhbHNlLFxuICAgICAgLy8gYWR2YW5jZWRTZWN1cml0eU1vZGUgaXMgZGVwcmVjYXRlZC4gVXNlIFN0YW5kYXJkVGhyZWF0UHJvdGVjdGlvbk1vZGUgYW5kIEN1c3RvbVRocmVhdFByb3RlY3Rpb25Nb2RlIGluc3RlYWQuXG4gICAgICBzdGFuZGFyZFRocmVhdFByb3RlY3Rpb25Nb2RlOiBhd3NfY29nbml0by5TdGFuZGFyZFRocmVhdFByb3RlY3Rpb25Nb2RlLkZVTExfRlVOQ1RJT04sXG4gICAgICAvLyBjdXN0b21UaHJlYXRQcm90ZWN0aW9uTW9kZTogYXdzX2NvZ25pdG8uQ3VzdG9tVGhyZWF0UHJvdGVjdGlvbk1vZGUuRU5BQkxFRCwgLy8gVW5jb21tZW50IGFuZCBjb25maWd1cmUgYXMgbmVlZGVkXG4gICAgICBhdXRvVmVyaWZ5OiB7XG4gICAgICAgIGVtYWlsOiB0cnVlLFxuICAgICAgfSxcbiAgICAgIHBhc3N3b3JkUG9saWN5OiB7XG4gICAgICAgIG1pbkxlbmd0aDogOCxcbiAgICAgICAgcmVxdWlyZVVwcGVyY2FzZTogdHJ1ZSxcbiAgICAgICAgcmVxdWlyZURpZ2l0czogdHJ1ZSxcbiAgICAgICAgcmVxdWlyZVN5bWJvbHM6IHRydWUsXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgY29uc3QgdXNlclBvb2xDbGllbnQgPSB0aGlzLnVzZXJQb29sLmFkZENsaWVudChcIndlYmFwcENsaWVudFwiLCB7XG4gICAgICBhdXRoRmxvd3M6IHtcbiAgICAgICAgdXNlclNycDogdHJ1ZSxcbiAgICAgICAgYWRtaW5Vc2VyUGFzc3dvcmQ6IHRydWUsXG4gICAgICB9LFxuICAgICAgcHJldmVudFVzZXJFeGlzdGVuY2VFcnJvcnM6IHRydWUsXG4gICAgICByZWZyZXNoVG9rZW5WYWxpZGl0eTogcHJvcHMucmVmcmVzaFRva2VuVmFsaWRpdHksXG4gICAgfSk7XG5cbiAgICBjb25zdCBpZGVudGl0eVBvb2wgPSBuZXcgSWRlbnRpdHlQb29sKHRoaXMsIFwiaWRlbnRpdHlQb29sXCIsIHtcbiAgICAgIGFsbG93VW5hdXRoZW50aWNhdGVkSWRlbnRpdGllczogZmFsc2UsXG4gICAgICBhdXRoZW50aWNhdGlvblByb3ZpZGVyczoge1xuICAgICAgICB1c2VyUG9vbHM6IFtcbiAgICAgICAgICBuZXcgVXNlclBvb2xBdXRoZW50aWNhdGlvblByb3ZpZGVyKHtcbiAgICAgICAgICAgIHVzZXJQb29sOiB0aGlzLnVzZXJQb29sLFxuICAgICAgICAgICAgdXNlclBvb2xDbGllbnQsXG4gICAgICAgICAgfSksXG4gICAgICAgIF0sXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgbmV3IENyZWF0ZVBvb2xVc2VyKHRoaXMsIFwiYWRtaW4tdXNlclwiLCB7XG4gICAgICBlbWFpbDogcHJvcHMuYWRtaW5FbWFpbCxcbiAgICAgIHVzZXJuYW1lOiBwcm9wcy51c2VyTmFtZSxcbiAgICAgIHVzZXJQb29sOiB0aGlzLnVzZXJQb29sLFxuICAgIH0pO1xuXG4gICAgdGhpcy5jb2duaXRvUGFyYW1zID0ge1xuICAgICAgdXNlclBvb2xJZDogdGhpcy51c2VyUG9vbC51c2VyUG9vbElkLFxuICAgICAgdXNlclBvb2xDbGllbnRJZDogdXNlclBvb2xDbGllbnQudXNlclBvb2xDbGllbnRJZCxcbiAgICAgIGlkZW50aXR5UG9vbElkOiBpZGVudGl0eVBvb2wuaWRlbnRpdHlQb29sSWQsXG4gICAgfTtcblxuICAgIG5ldyBDZm5PdXRwdXQodGhpcywgXCJVc2VyUG9vbElkXCIsIHtcbiAgICAgIHZhbHVlOiB0aGlzLnVzZXJQb29sLnVzZXJQb29sSWQsXG4gICAgfSk7XG4gICAgbmV3IENmbk91dHB1dCh0aGlzLCBcIlVzZXJQb29sQ2xpZW50SWRcIiwge1xuICAgICAgdmFsdWU6IHVzZXJQb29sQ2xpZW50LnVzZXJQb29sQ2xpZW50SWQsXG4gICAgfSk7XG4gICAgbmV3IENmbk91dHB1dCh0aGlzLCBcIklkZW50aXR5UG9vbElkXCIsIHtcbiAgICAgIHZhbHVlOiBpZGVudGl0eVBvb2wuaWRlbnRpdHlQb29sSWQsXG4gICAgfSk7XG5cbiAgICAvLyBTdXBwcmVzc2lvbnNcbiAgICBOYWdTdXBwcmVzc2lvbnMuYWRkUmVzb3VyY2VTdXBwcmVzc2lvbnModGhpcy51c2VyUG9vbCwgW1xuICAgICAge1xuICAgICAgICBpZDogXCJBd3NTb2x1dGlvbnMtQ09HMlwiLFxuICAgICAgICByZWFzb246IFwiTm8gbmVlZCBNRkEgZm9yIHNhbXBsZVwiLFxuICAgICAgfSxcbiAgICBdKTtcbiAgfVxufVxuXG5jbGFzcyBDcmVhdGVQb29sVXNlciBleHRlbmRzIENvbnN0cnVjdCB7XG4gIHB1YmxpYyByZWFkb25seSB1c2VybmFtZTogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICBjb25zdHJ1Y3RvcihcbiAgICBzY29wZTogQ29uc3RydWN0LFxuICAgIGlkOiBzdHJpbmcsXG4gICAgcHJvcHM6IHtcbiAgICAgIHVzZXJQb29sOiBhd3NfY29nbml0by5JVXNlclBvb2w7XG4gICAgICB1c2VybmFtZTogc3RyaW5nO1xuICAgICAgZW1haWw6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgICB9XG4gICkge1xuICAgIHN1cGVyKHNjb3BlLCBpZCk7XG5cbiAgICBjb25zdCBzdGF0ZW1lbnQgPSBuZXcgYXdzX2lhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgYWN0aW9uczogW1wiY29nbml0by1pZHA6QWRtaW5EZWxldGVVc2VyXCIsIFwiY29nbml0by1pZHA6QWRtaW5DcmVhdGVVc2VyXCJdLFxuICAgICAgcmVzb3VyY2VzOiBbcHJvcHMudXNlclBvb2wudXNlclBvb2xBcm5dLFxuICAgIH0pO1xuXG4gICAgbmV3IEF3c0N1c3RvbVJlc291cmNlKHRoaXMsIGBDcmVhdGVVc2VyLSR7aWR9YCwge1xuICAgICAgb25DcmVhdGU6IHtcbiAgICAgICAgc2VydmljZTogXCJDb2duaXRvSWRlbnRpdHlTZXJ2aWNlUHJvdmlkZXJcIixcbiAgICAgICAgYWN0aW9uOiBcImFkbWluQ3JlYXRlVXNlclwiLFxuICAgICAgICBwYXJhbWV0ZXJzOiB7XG4gICAgICAgICAgVXNlclBvb2xJZDogcHJvcHMudXNlclBvb2wudXNlclBvb2xJZCxcbiAgICAgICAgICBVc2VybmFtZTogcHJvcHMudXNlcm5hbWUsXG4gICAgICAgICAgVXNlckF0dHJpYnV0ZXM6IFtcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgTmFtZTogXCJlbWFpbFwiLFxuICAgICAgICAgICAgICBWYWx1ZTogcHJvcHMuZW1haWwsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAge1xuICAgICAgICAgICAgICBOYW1lOiBcImVtYWlsX3ZlcmlmaWVkXCIsXG4gICAgICAgICAgICAgIFZhbHVlOiBcInRydWVcIixcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgXSxcbiAgICAgICAgfSxcbiAgICAgICAgcGh5c2ljYWxSZXNvdXJjZUlkOiBQaHlzaWNhbFJlc291cmNlSWQub2YoXG4gICAgICAgICAgYENyZWF0ZVVzZXItJHtpZH0tJHtwcm9wcy51c2VybmFtZX1gXG4gICAgICAgICksXG4gICAgICB9LFxuICAgICAgb25EZWxldGU6IHtcbiAgICAgICAgc2VydmljZTogXCJDb2duaXRvSWRlbnRpdHlTZXJ2aWNlUHJvdmlkZXJcIixcbiAgICAgICAgYWN0aW9uOiBcImFkbWluRGVsZXRlVXNlclwiLFxuICAgICAgICBwYXJhbWV0ZXJzOiB7XG4gICAgICAgICAgVXNlclBvb2xJZDogcHJvcHMudXNlclBvb2wudXNlclBvb2xJZCxcbiAgICAgICAgICBVc2VybmFtZTogcHJvcHMudXNlcm5hbWUsXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgICAgcG9saWN5OiBBd3NDdXN0b21SZXNvdXJjZVBvbGljeS5mcm9tU3RhdGVtZW50cyhbc3RhdGVtZW50XSksXG4gICAgfSk7XG4gIH1cbn1cbiJdfQ==