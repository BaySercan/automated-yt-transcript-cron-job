# Complete Version Management System Guide

## 📋 **Overview**

This comprehensive version management system provides automated synchronization of versions across your entire project, including package.json, TypeScript constants, Docker images, and Git repositories.

## 🎯 **What This System Provides**

### **Automatic Version Synchronization**
- ✅ **package.json** - NPM package version
- ✅ **src/version.ts** - Runtime version constants
- ✅ **Docker Image Tags** - Container versioning
- ✅ **Git Tags** - Source control versioning

### **Version Bumping Options**
- **Semantic Versioning**: `v1.1.0`, `v1.1.1`, `v2.0.0`
- **Auto-generated**: `v20251101-173632` (timestamp-based)
- **Smart Bumping**: Automatic `major`, `minor`, or `patch` increments

### **Complete Automation Workflow**
1. Version bumping/sync across all files
2. Docker image build and testing
3. DockerHub push
4. Git commit and tagging
5. Cleanup of old Docker images

## 📁 **Created Files**

### **Core Version Files:**
1. **`src/version.ts`** - Runtime version constants
2. **`update-docker-versioned.sh`** - Enhanced Bash script
3. **`update-docker-versioned.ps1`** - Enhanced PowerShell script
4. **`VERSION_MANAGEMENT_GUIDE.md`** - This documentation

### **Supporting Files:**
5. **`DOCKER_UPDATE_GUIDE.md`** - Docker-specific documentation

## 🚀 **Quick Start Commands**

### **Windows (PowerShell):**
```powershell
# Auto version with timestamp
.\update-docker-versioned.ps1

# Bump minor version (v1.1.0 -> v1.2.0)
.\update-docker-versioned.ps1 -Version minor

# Bump patch version (v1.1.0 -> v1.1.1)
.\update-docker-versioned.ps1 -Version patch

# Specific version
.\update-docker-versioned.ps1 -Version v1.2.0

# Auto-versioning with testing
.\update-docker-versioned.ps1 -SyncVersions

# Skip Git operations
.\update-docker-versioned.ps1 -Version v1.1.0 -NoGit

# Skip testing (faster but less safe)
.\update-docker-versioned.ps1 -Version v1.1.0 -SkipTest
```

### **Linux/Mac (Bash):**
```bash
# Auto version with timestamp
./update-docker-versioned.sh

# Bump minor version
./update-docker-versioned.sh minor

# Bump patch version
./update-docker-versioned.sh patch

# Specific version
./update-docker-versioned.sh v1.2.0

# Version sync with Git tagging
./update-docker-versioned.sh v1.1.0

# Skip Git operations
./update-docker-versioned.sh v1.1.0 --no-git
```

## 🔧 **How Version Sync Works**

### **When You Run: `.\update-docker-versioned.ps1 -Version minor`**

The script performs these steps:

1. **Read Current Version**
   - From `package.json`: `"version": "1.1.0"`
   - Calculate new version: `1.1.0` → `1.2.0`

2. **Update Files**
   ```bash
   # package.json
   "version": "1.2.0"
   
   # src/version.ts
   version: '1.2.0'
   major: 1
   minor: 2
   patch: 0
   buildDate: '2025-11-01T20:24:00.123Z'
   ```

3. **Git Operations**
   ```bash
   git add .
   git commit -m "Update to version v1.2.0"
   git tag v1.2.0
   ```

4. **Docker Build & Push**
   ```bash
   docker build -t sercanhub/finfluencer-tracker:v1.2.0 .
   docker tag sercanhub/finfluencer-tracker:v1.2.0 sercanhub/finfluencer-tracker:latest
   docker push sercanhub/finfluencer-tracker:v1.2.0
   docker push sercanhub/finfluencer-tracker:latest
   ```

5. **Cleanup Old Images**
   - Keeps last 5 versions
   - Removes older versions to save space

## 📊 **Version File Structure**

### **`src/version.ts` (Runtime Constants)**
```typescript
export const VERSION = {
  version: '1.2.0',
  major: 1,
  minor: 2,
  patch: 0,
  buildDate: '2025-11-01T20:24:00.123Z',
  gitHash: 'abc123d',
  dockerTag: 'v1.2.0',
  
  fullVersion(): string {
    return `v${this.version} (build ${this.buildNumber})`;
  },
  
  detailedVersion(): string {
    return `${this.appName} v${this.version}
Build: ${this.buildDate}
Git: ${this.gitHash.substring(0, 7)}
Docker: ${this.dockerTag}`;
  }
};
```

### **`package.json` (NPM Version)**
```json
{
  "name": "finfluencer-tracker",
  "version": "1.2.0",
  "description": "Dockerized microservice..."
}
```

## 🎯 **Version Bumping Strategies**

### **Major Version (v1.2.0 → v2.0.0)**
Use when you have:
- Breaking API changes
- Database schema changes
- Major architectural changes
- Dropping support for old features

```powershell
.\update-docker-versioned.ps1 -Version major
```

### **Minor Version (v1.2.0 → v1.3.0)**
Use when you add:
- New features
- New API endpoints
- New configuration options
- Non-breaking enhancements

```powershell
.\update-docker-versioned.ps1 -Version minor
```

### **Patch Version (v1.2.0 → v1.2.1)**
Use for:
- Bug fixes
- Performance improvements
- Small optimizations
- Documentation updates

```powershell
.\update-docker-versioned.ps1 -Version patch
```

## 🔄 **Workflow Examples**

### **Development Workflow**
```powershell
# 1. Make your code changes
# 2. Test locally
npm run build
docker run --env-file .env sercanhub/finfluencer-tracker

# 3. Bump patch version and deploy
.\update-docker-versioned.ps1 -Version patch
```

### **Feature Release Workflow**
```powershell
# 1. Develop new features
# 2. Test thoroughly
npm test
.\update-docker-versioned.ps1 -Version v1.3.0 -SkipTest

# 3. Deploy to production
docker run -d --name finfluencer-tracker --env-file .env sercanhub/finfluencer-tracker:latest
```

### **Major Release Workflow**
```powershell
# 1. Prepare breaking changes
# 2. Update documentation
# 3. Bump major version
.\update-docker-versioned.ps1 -Version major

# 4. Create GitHub release
# 5. Deploy with migration scripts
```

## 🛠️ **Configuration Options**

### **Custom DockerHub Username**
Edit the script files and change:
```powershell
$DOCKERHUB_USERNAME = "your-username"
```

### **Custom Keep Versions**
```powershell
# Keep only last 3 versions
.\update-docker-versioned.ps1 -Version patch -KeepVersions 3
```

### **Disable Git Operations**
```powershell
# Skip Git entirely (for testing)
.\update-docker-versioned.ps1 -Version v1.2.0 -NoGit
```

### **Skip Testing**
```powershell
# Faster deployment but risky
.\update-docker-versioned.ps1 -Version v1.2.0 -SkipTest
```

## 📋 **Complete Command Reference**

### **PowerShell Commands:**
```powershell
# Show help
.\update-docker-versioned.ps1 -Help

# Auto version (timestamp)
.\update-docker-versioned.ps1

# Semantic versioning
.\update-docker-versioned.ps1 -Version v1.2.0
.\update-docker-versioned.ps1 -Version v2.0.0

# Smart bumping
.\update-docker-versioned.ps1 -Version major
.\update-docker-versioned.ps1 -Version minor
.\update-docker-versioned.ps1 -Version patch

# Options
.\update-docker-versioned.ps1 -Version v1.2.0 -SkipTest
.\update-docker-versioned.ps1 -Version v1.2.0 -NoGit
.\update-docker-versioned.ps1 -Version v1.2.0 -KeepVersions 3
.\update-docker-versioned.ps1 -CleanupOnly
.\update-docker-versioned.ps1 -SyncVersions

# Combinations
.\update-docker-versioned.ps1 -Version minor -SkipTest -KeepVersions 10
.\update-docker-versioned.ps1 -Version v1.3.0 -NoGit -SyncVersions
```

### **Bash Commands:**
```bash
# Show help
./update-docker-versioned.sh --help

# Auto version
./update-docker-versioned.sh

# Specific versions
./update-docker-versioned.sh v1.2.0
./update-docker-versioned.sh minor
./update-docker-versioned.sh patch

# Options
./update-docker-versioned.sh v1.2.0 --skip-test
./update-docker-versioned.sh v1.2.0 --no-git
./update-docker-versioned.sh --keep-versions 3
./update-docker-versioned.sh --cleanup-only

# Combinations
./update-docker-versioned.sh minor --skip-test --keep-versions 10
```

## ⚠️ **Important Notes**

### **Prerequisites**
1. **Git Repository**: Must be a Git repository for tagging
2. **Docker**: Docker Desktop or Engine installed
3. **DockerHub Login**: Must be logged in to DockerHub
4. **Environment Variables**: `.env` file properly formatted

### **Error Handling**
- Script stops on any error (`set -e`)
- Docker build fails if TypeScript compilation fails
- Git operations are skipped if not in Git repository
- Old version cleanup shows warnings but continues

### **Best Practices**

1. **Always Test First**
   ```powershell
   # Test build before pushing
   docker build -t finfluencer-tracker .
   docker run --env-file .env finfluencer-tracker
   ```

2. **Use Semantic Versioning**
   - `major.minor.patch` format
   - `v1.2.0`, `v1.2.1`, `v2.0.0`
   - Never skip numbers (don't use `v1.3`)

3. **Keep Git Clean**
   - Commit before running version script
   - Use meaningful commit messages
   - Push tags to remote repository

4. **Monitor Image Sizes**
   ```powershell
   # Check image sizes
   docker images sercanhub/finfluencer-tracker
   
   # Cleanup old images regularly
   .\update-docker-versioned.ps1 -CleanupOnly
   ```

## 🐛 **Troubleshooting**

### **Common Issues:**

1. **"Not logged in to DockerHub"**
   ```bash
   docker login
   # Enter username: sercanhub
   ```

2. **".env file not found"**
   - Ensure `.env` file exists in project root
   - Check file permissions

3. **"Git repository not found"**
   ```bash
   git init
   git remote add origin <your-repo-url>
   ```

4. **"Permission denied"**
   ```powershell
   # Run PowerShell as Administrator
   # Or set execution policy:
   Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
   ```

5. **"Version validation failed"**
   - Use semantic versioning: `v1.2.0`
   - Avoid spaces and special characters
   - Don't use `v1.3` (must include patch version)

### **Debug Mode**
```powershell
# Enable verbose output
$DebugPreference = "Continue"

# Check current version
Get-Content package.json | Select-String "version"
Get-Content src/version.ts | Select-String "version:"
```

## 📈 **Advanced Usage**

### **CI/CD Integration**
```yaml
# GitHub Actions example
- name: Update and Deploy
  run: |
    .\update-docker-versioned.ps1 -Version minor
    # Deploy to production
```

### **Custom Workflow Scripts**
```powershell
# Create custom workflow
$version = Read-Host "Enter version (major/minor/patch or custom)"
.\update-docker-versioned.ps1 -Version $version -SkipTest
```

### **Bulk Version Operations**
```bash
# Script to bump all projects in a monorepo
for dir in */; do
  cd $dir
  ../update-docker-versioned.sh patch
  cd ..
done
```

## 🎉 **Benefits**

### **For Developers**
- ✅ **One Command**: Update everything at once
- ✅ **Consistency**: All versions stay in sync
- ✅ **Error Prevention**: Automatic validation
- ✅ **Time Saving**: No manual file editing

### **For Operations**
- ✅ **DockerHub Organization**: Clean version tags
- ✅ **Git History**: Proper versioning commits
- ✅ **Deployment Safety**: Built-in testing
- ✅ **Maintenance**: Automatic cleanup

### **For Teams**
- ✅ **Standardization**: Everyone uses same process
- ✅ **Documentation**: Clear version history
- ✅ **Rollback Capability**: Keep multiple versions
- ✅ **Compliance**: Audit trail of all changes

---

**🎯 Your version management is now fully automated and comprehensive!**

**Next Steps:**
1. Test with a patch version bump
2. Set up your preferred version bump workflow  
3. Integrate into your deployment process
4. Train your team on the new system
