# Docker Update Scripts - Complete Guide

## 📋 Overview

I've created comprehensive Docker update scripts for your Finfluencer Tracker project. You now have both Bash (Linux/Mac) and PowerShell (Windows) versions that automate the entire Docker build, test, and push process.

## 📁 Created Files

### 1. `update-docker.sh` (Bash Script)
- **For**: Linux, macOS, Git Bash on Windows
- **Usage**: `./update-docker.sh [version] [options]`

### 2. `update-docker.ps1` (PowerShell Script)
- **For**: Windows PowerShell
- **Usage**: `.\update-docker.ps1 [version] [options]`

### 3. `DOCKER_UPDATE_GUIDE.md` (This File)
- Complete documentation and usage guide

## 🚀 Quick Start Commands

### For Windows Users (PowerShell):
```powershell
# Show help
.\update-docker.ps1 -Help

# Auto-build with timestamp version
.\update-docker.ps1

# Specific version
.\update-docker.ps1 -Version v1.1.0

# Skip testing (faster but less safe)
.\update-docker.ps1 -Version v1.1.0 -SkipTest

# Just cleanup old images
.\update-docker.ps1 -CleanupOnly

# Keep only last 3 versions
.\update-docker.ps1 -KeepVersions 3
```

### For Linux/Mac Users (Bash):
```bash
# Show help
./update-docker.sh --help

# Auto-build with timestamp version
./update-docker.sh

# Specific version
./update-docker.sh v1.1.0

# Skip testing
./update-docker.sh v1.1.0 --skip-test

# Just cleanup old images
./update-docker.sh --cleanup-only

# Keep only last 3 versions
./update-docker.sh --keep-versions 3
```

## 🔧 What the Scripts Do

### Complete Workflow:
1. **Validate Environment**
   - Check `.env` file exists and is properly formatted
   - Verify DockerHub login

2. **Build Docker Image**
   - Build with specified version tag
   - Also create `latest` tag

3. **Test Locally**
   - Run container with your environment variables
   - Check for errors

4. **Push to DockerHub**
   - Push specific version tag
   - Push `latest` tag
   - Using your username: `sercanhub`

5. **Cleanup Old Images**
   - Remove old versions (keeps last 5 by default)
   - Clean up dangling images

### Safety Features:
- **Error Handling**: Script stops on any failure
- **Local Testing**: Tests before pushing to DockerHub
- **Validation**: Checks .env file format
- **Login Verification**: Confirms DockerHub authentication

## 📊 Version Management

### Auto-Generated Versions:
When no version is specified, scripts create timestamps like:
- `v20251101-173632`
- `v20251101-180145`

### Manual Versions:
Use semantic versioning:
- `v1.0.0` - Major version (breaking changes)
- `v1.1.0` - Minor version (new features)
- `v1.1.1` - Patch version (bug fixes)

## 🧹 Image Cleanup

### Automatic Cleanup:
- Keeps last 5 versions by default
- Removes dangling images
- Shows cleanup summary

### Manual Cleanup:
```powershell
# Keep only last 3 versions
.\update-docker.ps1 -KeepVersions 3

# Just cleanup without building
.\update-docker.ps1 -CleanupOnly
```

## ⚠️ Prerequisites

### 1. Docker Installation
- Docker Desktop or Docker Engine
- Verify with: `docker --version`

### 2. DockerHub Login
```bash
docker login
# Enter your DockerHub credentials
# Username: sercanhub
```

### 3. Environment File
- `.env` file with all required variables
- Format: `VARIABLE=value` (no spaces around =)

## 🔍 Troubleshooting

### Common Issues:

1. **Docker not installed**
   ```bash
   # Check Docker
   docker --version
   
   # Install Docker Desktop (Windows/Mac)
   # Install Docker Engine (Linux)
   ```

2. **Not logged in to DockerHub**
   ```bash
   docker login
   # Enter username: sercanhub
   ```

3. **.env file not found**
   - Ensure `.env` file exists in project root
   - Check file formatting (no spaces around =)

4. **Permission denied (Windows)**
   ```powershell
   # Run PowerShell as Administrator
   # Or use: Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
   ```

5. **Build fails**
   ```powershell
   # Check Docker build manually
   docker build -t finfluencer-tracker .
   
   # Check TypeScript compilation
   npm run build
   ```

## 📈 Usage Examples

### Development Workflow:
```powershell
# 1. Make your code changes
# 2. Test locally first
npm run build
docker run --env-file .env finfluencer-tracker

# 3. Build and push
.\update-docker.ps1 -Version v1.2.0
```

### Production Deployment:
```powershell
# 1. Test everything thoroughly
.\update-docker.ps1 -Version v1.2.0

# 2. Deploy to production
docker run -d --name finfluencer-tracker --env-file .env sercanhub/finfluencer-tracker:latest
```

### Maintenance:
```powershell
# Cleanup old images monthly
.\update-docker.ps1 -CleanupOnly

# Check current images
.\update-docker.ps1 -CleanupOnly
```

## 📝 Environment Variables

Your `.env` file should contain:
```bash
# YouTube API
YOUTUBE_API_KEY=your_key

# Supabase
SUPABASE_URL=your_url
SUPABASE_SERVICE_KEY=your_key

# OpenRouter
OPENROUTER_API_KEY=your_key
OPENROUTER_MODEL=your_model

# RapidAPI
RAPIDAPI_URL=https://youtube-multi-api.p.rapidapi.com
RAPIDAPI_HOST=youtube-multi-api.p.rapidapi.com
RAPIDAPI_KEY=your_key

# App Config
START_DATE=2025-01-01
TZ=Europe/Istanbul
LOG_LEVEL=info
```

## 🎯 Next Steps

1. **Test the scripts** with a small update
2. **Set up automation** (CI/CD pipeline)
3. **Configure monitoring** for DockerHub images
4. **Create deployment scripts** for production

## 🆘 Support

If you encounter issues:

1. Check the troubleshooting section above
2. Test Docker build manually: `docker build -t finfluencer-tracker .`
3. Verify environment variables in `.env`
4. Check DockerHub login: `docker info`

---

**Scripts created successfully! Your Docker workflow is now automated and streamlined.**
