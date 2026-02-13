# Graph Application using Amazon Neptune

## Architecture overview

![Archiecture overview](./docs/images/architecture.png)

## Prerequisites

- Node.js >= 18.19.0
- An AWS Account
- AWS CLI
- Configuration and credential file settings
  - See [the doc](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-files.html) in detail
- Docker
- Stored `vertex.csv` and `edge.csv` files in Amazon S3 in your AWS Account as [the post](https://aws.amazon.com/blogs/database/build-a-graph-application-with-amazon-neptune-and-aws-amplify/) mentioned

## Deployment

### Option 1: Automated CI/CD Deployment (Recommended)

This project includes a GitHub Actions workflow that automatically deploys the application to AWS when code is pushed to the `main` branch.

#### Prerequisites for CI/CD

1. **AWS OIDC Configuration**: An IAM OIDC identity provider and role must be configured in your AWS account with:
   - Trust relationship to the GitHub repository: `ppottorff/build-neptune-graphapp-cdk`
   - Permissions for CDK deployments (CloudFormation, IAM, S3, Neptune, VPC, Lambda, AppSync, Cognito, CloudFront, WAF)
   - Role name: `GitHubActionsDeployRole`

2. **CDK Bootstrap**: Your AWS account must be bootstrapped for CDK:
   ```bash
   npx cdk bootstrap aws://384492676078/us-east-1
   ```

3. **Configuration**: Ensure `config.js` is properly configured with your settings.

#### How CI/CD Works

When you push to the `main` branch:
1. **Backend Deployment**: Deploys Neptune, VPC, API (AppSync + Lambda), and Cognito
2. **Frontend Deployment**: Generates environment variables and deploys React app to S3/CloudFront
3. **Outputs**: Displays CloudFront URL and other key endpoints in the GitHub Actions summary

The workflow uses AWS OIDC authentication (no long-term credentials stored in GitHub).

### Option 2: Manual Deployment

#### Create a config file as `config.ts`

Copy `config.sample.ts` and paste the file as `config.ts`. Then modify the `baseConfig` properties as your enviroment and requirements. For the reference, `baseConfig` in the sample file as follows:

```ts
const baseConfig = {
  appName: "graphApp",
  region: "us-east-1",
  adminEmail: "your_email@acme.com",
  allowedIps: [],
  wafParamName: "graphAppWafWebACLID",
  webBucketsRemovalPolicy: RemovalPolicy.DESTROY,
  s3Uri: {
    edge: "EDGE_S3_URI",
    vertex: "VERTEX_S3_URI",
  },
};
```

See the [config doc](docs/config.md) if you check the properties in detail.

#### Manual Deployment Steps

1. Install the dependencies

```zsh
npm ci
```

2. Deploy backend

```zsh
## Execute the bootstrapping if you have never executed bootstrap command with CDK in your region.
npm run cdk bootstrap -- --profile <YOUR_AWS_PROFILE>

## Also execute the bootstrapping command for us-east-1 if your region is different from `us-east-1`
npm run cdk bootstrap -- --profile <YOUR_AWS_PROFILE> --region us-east-1

npm run deployBackend -- --all --profile <YOUR_AWS_PROFILE>
```

You can see the following outputs after backend deployment.

```zsh
Outputs:
graphApp-ApiStack.apiFunctionUrlAAAA = https://aaaa.lambda-url.us-east-1.on.aws/
graphApp-ApiStack.apiGraphqlUrlBBBB = https://bbbb.appsync-api.us-east-1.amazonaws.com/graphql
graphApp-ApiStack.cognitoIdentityPoolIdXXXX = us-east-1:xxxx
graphApp-ApiStack.cognitoUserPoolClientIdYYYY = yyyy
graphApp-ApiStack.cognitoUserPoolIdZZZZ = us-east-1_zzzz
```

3. Generate env file for React

```zsh
npm run generateEnv
```

4. Deploy frontend

```zsh
npm run deployFrontend -- --all --profile <YOUR_AWS_PROFILE>
```

You can see the graph application url as follows.

```zsh
Outputs:
graphApp-WebappStack.webappurl4CF7BBD7 = xyz.cloudfront.net
```

## Bulk load with Lambda function URL

Invoking the function url in AWS Lambda can do bulk load from S3 stored `edge.csv` and `vertex.csv` to Amazon Neptune. You can see the function url after deploying backend.

```zsh
Outputs:
graphApp-ApiStack.apiFunctionUrlAAAA = https://aaaa.lambda-url.us-east-1.on.aws/
```

Set the variables as follows, and then invoke the function url with `curl`.

```zsh

export AWS_ACCESS_KEY_ID="YOUR_ACCESS_KEY"
export AWS_SECRET_ACCESS_KEY="YYY"
export AWS_SESSION_TOKEN="ZZZZ"
export FUNCTION_URL="YOUR_FUNCTION_URL"
curl  ${FUNCTION_URL} \
  -H "X-Amz-Security-Token: ${AWS_SESSION_TOKEN}" \
  --aws-sigv4 "aws:amz:us-east-1:lambda" \
  --user "${AWS_ACCESS_KEY_ID}:${AWS_SECRET_ACCESS_KEY}"


Start streaming response
Start bulk load of s3://YOUR_BUCKET/vertex.csv
Load status checking of s3://YOUR_BUCKET/vertex.csv
Waiting for load status change ................................
Load completed
200 OK
Start bulk load of s3://YOUR_BUCKET/edge.csv
Load status checking of s3://YOUR_BUCKET/edge.csv
Waiting for load status change ............................................................................................
Load completed
200 OK
End streaming response%
```

## Useful commands

- `npm run deployBackend`
  - Deploy the infrastructure stack with AWS CDK
- `npm run deployFrontend`
  - Deploy the frontend stack with AWS CDK
- `npm run destroyBackend`
  - Destroy the infrastructure stack with AWS CDK
- `npm run destroyFrontend`
  - Destroy the frontend stack with AWS CDK
- `npm run generateEnv`
  - Generate the environment variables in `.env` for frontend.

## Neptune Cluster Control

The Neptune cluster is scheduled to automatically stop at **midnight Pacific** and start at **4pm Pacific** to save costs. You can also manually control the cluster at any time using the **Neptune Cluster Control** workflow.

### GitHub CLI

```bash
# Check current cluster status
gh workflow run neptune-control.yml -f action=status

# Start the cluster
gh workflow run neptune-control.yml -f action=start

# Stop the cluster
gh workflow run neptune-control.yml -f action=stop
```

### GitHub UI

1. Go to **Actions** → **Neptune Cluster Control**
2. Click **Run workflow**
3. Select `start`, `stop`, or `status`
4. Click **Run workflow**

### Copilot

You can also ask GitHub Copilot to run the workflow:

> "Run the Neptune Cluster Control workflow with action start"

## CI/CD Setup Guide

### Setting up AWS OIDC for GitHub Actions

To enable automated deployments via GitHub Actions, you need to configure AWS OIDC authentication:

#### 1. Create OIDC Identity Provider in AWS

```bash
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com \
  --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1
```

#### 2. Create IAM Role for GitHub Actions

Create a role with the following trust policy (replace `<ACCOUNT_ID>` and `<REPO_OWNER>/<REPO_NAME>`):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": "repo:<REPO_OWNER>/<REPO_NAME>:*"
        }
      }
    }
  ]
}
```

#### 3. Attach Required Policies

The role needs permissions for:
- CloudFormation (full access for stack operations)
- CDK operations (S3, SSM for CDK assets)
- Neptune, VPC, EC2 (for infrastructure)
- Lambda, AppSync, Cognito (for API and auth)
- S3, CloudFront, WAF (for frontend)
- IAM (for creating service roles)

Example managed policies:
- `PowerUserAccess` (recommended for simplicity)
- Or create custom policies with specific permissions

#### 4. Update Workflow Configuration

If your role name is different from `GitHubActionsDeployRole`, update `.github/workflows/deploy.yml`:

```yaml
- name: Configure AWS credentials
  uses: aws-actions/configure-aws-credentials@v4
  with:
    role-to-assume: arn:aws:iam::${{ env.AWS_ACCOUNT_ID }}:role/YourRoleName
    aws-region: ${{ env.AWS_REGION }}
```

### Troubleshooting CI/CD

#### Deployment fails with "AssumeRole" error
- Verify the OIDC provider is configured correctly
- Check the trust policy includes the correct repository
- Ensure the role has necessary permissions

#### CDK Bootstrap error
- Run `npx cdk bootstrap aws://<ACCOUNT_ID>/us-east-1` manually
- Verify the role has permissions to create CDK bootstrap resources

#### Frontend build fails
- Check that `pnpm` is installed in the workflow (should be automatic)
- Verify `app/web/.env` file is generated correctly from backend outputs

#### Missing outputs after deployment
- Ensure backend deployment completes successfully before frontend
- Check `cdk-infra.json` file is created and uploaded as artifact

## Security

See [CONTRIBUTING](CONTRIBUTING.md#security-issue-notifications) for more
information.

## License

This code is licensed under the MIT-0 License. See [the LICENSE file](LICENSE).
