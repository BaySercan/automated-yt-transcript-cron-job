# Northflank Environment Variables Setup Guide

## Overview
This guide explains how to securely configure environment variables for your YouTube Transcript Generator when deploying to Northflank.

## Security Benefits
- ✅ **No secrets in Docker image** - Your .env file is completely excluded
- ✅ **External secret management** - All credentials managed by Northflank
- ✅ **Environment-specific configurations** - Different values for staging/production
- ✅ **Secure deployment** - Safe to push images to Docker Hub

## Required Environment Variables

### API Keys and Configuration
Set these in your Northflank project settings:

| Variable Name | Description | Example Value |
|---------------|-------------|---------------|
| `YOUTUBE_API_KEY` | YouTube Data API v3 key | `AIzaSyAmoxzO2Vfc4c1e_z8Au3Av-vnzknAbsNY` |
| `SUPABASE_URL` | Your Supabase project URL | `https://prewzthpwmhltsdnvexb.supabase.co` |
| `SUPABASE_SERVICE_KEY` | Supabase service role key | `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...` |
| `OPENROUTER_API_KEY` | OpenRouter API key | `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` |
| `OPENROUTER_MODEL` | AI model to use | `deepseek/deepseek-chat-v3.1:free` |

### Optional Configuration
| Variable Name | Description | Default Value |
|---------------|-------------|---------------|
| `START_DATE` | Starting date for analysis | `2025-01-01` |
| `TZ` | Timezone | `Europe/Istanbul` |
| `LOG_LEVEL` | Logging verbosity | `info` |
| `RAPIDAPI_URL` | RapidAPI endpoint | `https://youtube-multi-api.p.rapidapi.com` |
| `RAPIDAPI_HOST` | RapidAPI host | `youtube-multi-api.p.rapidapi.com` |
| `RAPIDAPI_KEY` | RapidAPI key | `fa0171d167mshe2674f5a8158568p192481jsn40d154d5e127` |

## Northflank Setup Steps

### Step 1: Access Environment Variables
1. Go to your Northflank project dashboard
2. Navigate to **Settings** → **Environment Variables**
3. Click **Add Variable**

### Step 2: Add Required Variables
For each required variable:
1. **Name**: Enter the exact variable name (case-sensitive)
2. **Value**: Enter the corresponding value from your .env file
3. **Environment**: Select all relevant environments (Production, Staging)
4. Click **Add Variable**

### Step 3: Verify Configuration
1. Deploy your updated Docker image to Northflank
2. Check the logs to ensure all variables are "PRESENT"
3. Verify no "MISSING" environment variable errors

## Environment-Specific Configuration

### Development/Staging
Use test or development API keys for non-production environments.

### Production
Use production API keys and ensure all credentials are valid.

## Docker Image Deployment

### Building and Pushing
```bash
# Build the secure image
docker build -t your-username/youtube-transcript-generator:latest .

# Push to Docker Hub
docker push your-username/youtube-transcript-generator:latest
```

### Northflank Deployment
1. In Northflank, create a new Service
2. Select **Container** deployment type
3. Enter your Docker image: `your-username/youtube-transcript-generator:latest`
4. Environment variables will be automatically loaded from project settings

## Security Best Practices

### ✅ What You Should Do
- Keep your .env file only on local development machines
- Use Northflank's environment variable management
- Rotate API keys regularly
- Use different credentials for different environments
- Monitor your API usage and costs

### ❌ What You Should NOT Do
- Never commit .env files to version control
- Don't embed credentials directly in Docker images
- Avoid sharing API keys in chat or documentation
- Don't use the same credentials across all environments

## Troubleshooting

### Common Issues
1. **"supabaseUrl is required"** - Missing `SUPABASE_URL` variable
2. **"YOUTUBE_API_KEY is missing"** - Variable name mismatch (case-sensitive)
3. **API authentication failures** - Verify your keys are correct and active

### Debug Mode
Check the application logs in Northflank - you'll see:
```
🔍 Configuration Debug:
- YOUTUBE_API_KEY: PRESENT
- SUPABASE_URL: PRESENT
- SUPABASE_SERVICE_KEY: PRESENT
- OPENROUTER_API_KEY: PRESENT
```

All should show "PRESENT" - if any show "MISSING", check the variable name and value.

## File Structure Security

After implementing these changes:
```
your-project/
├── .dockerignore          # ✅ Excludes .env and other sensitive files
├── Dockerfile             # ✅ Copies only necessary files
├── src/                   # ✅ Source code only
├── dist/                  # ✅ Built application
└── .env                   # ✅ Never copied to Docker image
```

## Benefits Achieved

### Before (Insecure)
- ❌ Sensitive .env file baked into Docker image
- ❌ API keys visible to anyone who pulls the image
- ❌ No separation of build-time and runtime secrets
- ❌ Security vulnerability in container registry

### After (Secure)
- ✅ Zero secrets in Docker image
- ✅ External environment variable management
- ✅ Safe to push to Docker Hub or any registry
- ✅ Environment-specific configurations
- ✅ Professional deployment workflow

Your application is now ready for secure deployment to Northflank with no risk of credential exposure!
