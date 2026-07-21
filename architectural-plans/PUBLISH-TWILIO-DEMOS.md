# Plan: Publish @mcp-shim/connector to twilio-demos Org

**Status:** Draft  
**Target Registry:** GitHub Packages (internal)  
**Scope:** Move from personal repo to `twilio-demos` organization

---

## Prerequisites

1. Access to `https://github.com/twilio-demos/` organization
2. Repository created under `twilio-demos` org (suggested name: `mcp-shim`)
3. GitHub Personal Access Token with `read:packages` and `write:packages` scopes

---

## Step-by-Step Migration

### 1. Repository Setup

Create new repository under `twilio-demos` org:
- Name: `mcp-shim` (or preferred name)
- Visibility: Private (internal org)
- Description: "Customer-side MCP connector — WSS tunnel to controller, local MCP dispatcher"

Push existing code to new remote:
```bash
# Add new remote (keep origin as backup during transition)
git remote add upstream https://github.com/twilio-demos/mcp-shim.git

# Push all branches
git push upstream main

# Optional: push tags if any exist
git push upstream --tags
```

After verification, switch origin:
```bash
git remote set-url origin https://github.com/twilio-demos/mcp-shim.git
git remote remove upstream  # if added temporarily
```

### 2. Package.json Changes

File: `packages/connector/package.json`

**Change package name** (scope must match GitHub org):
```json
{
  "name": "@twilio-demos/mcp-connector"
}
```

**Remove private flag**:
```json
{
  "private": true   // <-- DELETE THIS LINE
}
```

**Add repository and publishConfig**:
```json
{
  "repository": {
    "type": "git",
    "url": "https://github.com/twilio-demos/mcp-shim.git"
  },
  "publishConfig": {
    "registry": "https://npm.pkg.github.com"
  }
}
```

Diff summary:
```diff
 {
-  "name": "@mcp-shim/connector",
+  "name": "@twilio-demos/mcp-connector",
   "version": "0.1.0",
-  "private": true,
   "type": "module",
+  "repository": {
+    "type": "git",
+    "url": "https://github.com/twilio-demos/mcp-shim.git"
+  },
+  "publishConfig": {
+    "registry": "https://npm.pkg.github.com"
+  },
```

### 3. GitHub Packages Authentication

Create `.npmrc` at project root (gitignore this in a real project, or use env var approach):

```bash
# ~/.npmrc (user-level, preferred for security)
//npm.pkg.github.com/:_authToken=YOUR_GITHUB_TOKEN
```

Or authenticate per-session:
```bash
npm login --registry=https://npm.pkg.github.com --scope=@twilio-demos
# Username: your GitHub username
# Password: your Personal Access Token (not password)
```

### 4. Verify Build

Ensure the package builds cleanly before publish:

```bash
cd packages/connector
npm run build
npm pack --dry-run  # Shows what files would be published
```

### 5. Publish

First publish (creates package on GH Packages):
```bash
cd packages/connector
npm publish
```

Subsequent publishes (version bump required):
```bash
npm version patch   # or minor, major
npm publish
```

**Note:** GitHub Packages requires unique versions—you cannot overwrite an existing version. Use `npm version` to bump before each publish.

---

## Post-Publish: Consumer Usage

Other projects in the org install via:

```bash
# With .npmrc configured for GH Packages
npm install @twilio-demos/mcp-connector
```

Required in consuming project's `.npmrc`:
```
@twilio-demos:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

Or inline in `.npmrc` with token (CI-friendly via env substitution).

---

## Checklist

- [ ] Repository created under `twilio-demos/mcp-shim`
- [ ] Code pushed to new org repo
- [ ] `packages/connector/package.json` updated:
  - [ ] Name changed to `@twilio-demos/mcp-connector`
  - [ ] `"private": true` removed
  - [ ] `repository` field added
  - [ ] `publishConfig.registry` set to `https://npm.pkg.github.com`
- [ ] Git remote updated to point to new org repo
- [ ] GitHub Personal Access Token created with `write:packages` scope
- [ ] `.npmrc` configured with GH Packages auth
- [ ] Build verified (`npm run build`)
- [ ] Dry-run pack looks correct (`npm pack --dry-run`)
- [ ] First publish successful
- [ ] CI/CD updated (if applicable) with registry auth

---

## Open Questions

1. **Version for first publish:** Keep `0.1.0` or start at `1.0.0`?
2. **CI/CD integration:** GitHub Actions workflow for auto-publish on tag?
3. **Additional maintainers:** Need to add other org members to package permissions?
4. **Deprecation of old package:** If `@mcp-shim/connector` was ever published publicly, need deprecation notice?

---

## References

- [GitHub Packages: Working with the npm registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry)
- [CLAUDE.md: Package exports and SDK](./CLAUDE.md#adding-a-new-mcp)
