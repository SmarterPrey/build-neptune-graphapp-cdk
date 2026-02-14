# GitHub Copilot Instructions for build-neptune-graphapp-cdk

## CDK Infrastructure Development

### TypeScript Requirement
- **ALL CDK infrastructure code MUST be written in TypeScript**
- CDK stacks, constructs, and configuration files should use TypeScript (`.ts` files)
- Follow the existing patterns in `lib/`, `bin/`, and `lib/constructs/` directories
- Ensure proper TypeScript typing for all CDK constructs and AWS resources
- Use CDK L2 constructs when available, L1 constructs (Cfn*) only when necessary

### CDK Best Practices
- Import AWS CDK modules from `aws-cdk-lib` (v2 syntax)
- Use `constructs` package for the `Construct` base class
- Follow the existing stack structure:
  - Network infrastructure in `lib/neptune-network-stack.ts`
  - API layer in `lib/api-stack.ts`
  - Web frontend in `lib/webapp-stack.ts`
  - WAF rules in `lib/waf-stack.ts`
  - Reusable constructs in `lib/constructs/`
- Maintain separation between frontend (`bin/frontend.ts`) and backend (`bin/backend.ts`) entry points
- Use the configuration pattern from `config.ts` for environment-specific settings
- Always compile TypeScript (`npm run build`) before deploying

### Neptune Graph Database
- This application uses Amazon Neptune (graph database), not RDS
- Neptune infrastructure defined in `lib/constructs/neptune.ts`
- Event notifications use RDS event subscriptions (Neptune uses RDS service primitives)
- Follow existing patterns for Neptune cluster configuration and monitoring

## GitHub Issue Creation

### AI-Created Issues
- **ALL GitHub issues created by Copilot MUST include "AI Created" at the beginning of the title**
- Format: `AI Created: <actual issue title>`
- Example: `AI Created: migrate from sms notifications to e-mail in paramstore`
- This helps distinguish AI-generated issues from human-created ones

### Issue Content Guidelines
- Provide clear, detailed descriptions
- Include relevant file paths as markdown links
- Add verification steps when applicable
- Reference related code patterns or existing implementations
- Assign to appropriate team members when requested

## Code Style and Standards

### General TypeScript
- Use modern TypeScript features (async/await, optional chaining, nullish coalescing)
- Prefer `const` over `let`, avoid `var`
- Use meaningful variable and function names
- Add JSDoc comments for complex functions or constructs

### AWS CDK Patterns
- Use grants (`grant*` methods) for IAM permissions instead of manual policy statements
- Leverage CDK's built-in validation and best practices
- Use removal policies explicitly (especially for stateful resources)
- Tag resources appropriately using `Tags.of()`

### Frontend Development
- Frontend code in `app/web/` uses React + TypeScript + Vite
- Follow the existing routing patterns using TanStack Router
- Use shadcn/ui components from `app/web/src/components/ui/`
- Maintain Amplify configuration in `app/web/src/config/amplify.ts`

## Security and Compliance

- Enable encryption at rest for stateful resources (S3, SNS, Neptune)
- Use KMS customer-managed keys with rotation enabled
- Follow the security patterns in `lib/waf-stack.ts`
- Maintain CDK Nag compliance (see `nag/NagLogger.ts`)
- Use least-privilege IAM policies

## Documentation

- Update `docs/config.md` when configuration options change
- Keep README.md current with deployment instructions
- Document breaking changes or new features in commit messages
- Add inline comments for non-obvious code decisions