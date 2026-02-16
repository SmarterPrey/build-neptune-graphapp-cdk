"use strict";
var __extends = (this && this.__extends) || (function () {
    var extendStatics = function (d, b) {
        extendStatics = Object.setPrototypeOf ||
            ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
            function (d, b) { for (var p in b) if (Object.prototype.hasOwnProperty.call(b, p)) d[p] = b[p]; };
        return extendStatics(d, b);
    };
    return function (d, b) {
        if (typeof b !== "function" && b !== null)
            throw new TypeError("Class extends value " + String(b) + " is not a constructor or null");
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.Cognito = void 0;
var constructs_1 = require("constructs");
var aws_cdk_lib_1 = require("aws-cdk-lib");
var custom_resources_1 = require("aws-cdk-lib/custom-resources");
var aws_cognito_identitypool_1 = require("aws-cdk-lib/aws-cognito-identitypool");
var cdk_nag_1 = require("cdk-nag");
var Cognito = /** @class */ (function (_super) {
    __extends(Cognito, _super);
    function Cognito(scope, id, props) {
        var _this = _super.call(this, scope, id) || this;
        if (!props.userName)
            props.userName = props.adminEmail.split("@")[0];
        _this.userPool = new aws_cdk_lib_1.aws_cognito.UserPool(_this, "userpool", {
            userPoolName: "".concat(id, "-app-userpool"),
            signInAliases: {
                username: true,
                email: true,
            },
            accountRecovery: aws_cdk_lib_1.aws_cognito.AccountRecovery.EMAIL_ONLY,
            removalPolicy: aws_cdk_lib_1.RemovalPolicy.DESTROY,
            selfSignUpEnabled: false,
            featurePlan: aws_cdk_lib_1.aws_cognito.FeaturePlan.PLUS,
            standardThreatProtectionMode: aws_cdk_lib_1.aws_cognito.StandardThreatProtectionMode.FULL_FUNCTION,
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
        var userPoolClient = _this.userPool.addClient("webappClient", {
            authFlows: {
                userSrp: true,
                adminUserPassword: true,
            },
            preventUserExistenceErrors: true,
            refreshTokenValidity: props.refreshTokenValidity,
        });
        var identityPool = new aws_cognito_identitypool_1.IdentityPool(_this, "identityPool", {
            allowUnauthenticatedIdentities: false,
            authenticationProviders: {
                userPools: [
                    new aws_cognito_identitypool_1.UserPoolAuthenticationProvider({
                        userPool: _this.userPool,
                        userPoolClient: userPoolClient,
                    }),
                ],
            },
        });
        new CreatePoolUser(_this, "admin-user", {
            email: props.adminEmail,
            username: props.userName,
            userPool: _this.userPool,
        });
        _this.cognitoParams = {
            userPoolId: _this.userPool.userPoolId,
            userPoolClientId: userPoolClient.userPoolClientId,
            identityPoolId: identityPool.identityPoolId,
        };
        new aws_cdk_lib_1.CfnOutput(_this, "UserPoolId", {
            value: _this.userPool.userPoolId,
        });
        new aws_cdk_lib_1.CfnOutput(_this, "UserPoolClientId", {
            value: userPoolClient.userPoolClientId,
        });
        new aws_cdk_lib_1.CfnOutput(_this, "IdentityPoolId", {
            value: identityPool.identityPoolId,
        });
        // Suppressions
        cdk_nag_1.NagSuppressions.addResourceSuppressions(_this.userPool, [
            {
                id: "AwsSolutions-COG2",
                reason: "No need MFA for sample",
            },
        ]);
        return _this;
    }
    return Cognito;
}(constructs_1.Construct));
exports.Cognito = Cognito;
var CreatePoolUser = /** @class */ (function (_super) {
    __extends(CreatePoolUser, _super);
    function CreatePoolUser(scope, id, props) {
        var _this = _super.call(this, scope, id) || this;
        var statement = new aws_cdk_lib_1.aws_iam.PolicyStatement({
            actions: ["cognito-idp:AdminDeleteUser", "cognito-idp:AdminCreateUser"],
            resources: [props.userPool.userPoolArn],
        });
        new custom_resources_1.AwsCustomResource(_this, "CreateUser-".concat(id), {
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
                physicalResourceId: custom_resources_1.PhysicalResourceId.of("CreateUser-".concat(id, "-").concat(props.username)),
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
        return _this;
    }
    return CreatePoolUser;
}(constructs_1.Construct));
