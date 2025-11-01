# Enhanced Finfluencer Tracker Docker Update Script with Version Management (PowerShell)
# Usage: .\update-docker-versioned.ps1 [version] [options]
# Examples:
#   .\update-docker-versioned.ps1                 # Auto-generates version
#   .\update-docker-versioned.ps1 v1.1.0          # Specific version
#   .\update-docker-versioned.ps1 minor           # Bump minor version
#   .\update-docker-versioned.ps1 patch           # Bump patch version
#   .\update-docker-versioned.ps1 -CleanupOnly    # Just cleanup old images
#   .\update-docker-versioned.ps1 -Help           # Show help

param(
    [Parameter(HelpMessage="Version tag (e.g., v1.1.0) or bump type (major, minor, patch)")]
    [string]$Version,
    
    [Parameter(HelpMessage="Skip local testing after build")]
    [switch]$SkipTest,
    
    [Parameter(HelpMessage="Only clean up old Docker images")]
    [switch]$CleanupOnly,
    
    [Parameter(HelpMessage="Sync versions across all project files")]
    [switch]$SyncVersions,
    
    [Parameter(HelpMessage="Skip Git tagging and commits")]
    [switch]$NoGit,
    
    [Parameter(HelpMessage="Number of versions to keep (default: 5)")]
    [int]$KeepVersions = 5,
    
    [Parameter(HelpMessage="Show help message")]
    [switch]$Help
)

# Configuration
$DOCKERHUB_USERNAME = "sercanhub"
$IMAGE_NAME = "$DOCKERHUB_USERNAME/finfluencer-tracker"
$LOCAL_IMAGE_NAME = "finfluencer-tracker"
$ENV_FILE = ".env"
$PACKAGE_JSON = "package.json"
$VERSION_FILE = "src/version.ts"

# Colors for PowerShell output
$RED = "Red"
$GREEN = "Green"
$YELLOW = "Yellow"
$BLUE = "Cyan"

# Logging functions
function Write-LogInfo {
    param([string]$Message)
    Write-Host "[INFO] $Message" -ForegroundColor $BLUE
}

function Write-LogSuccess {
    param([string]$Message)
    Write-Host "[SUCCESS] $Message" -ForegroundColor $GREEN
}

function Write-LogWarning {
    param([string]$Message)
    Write-Host "[WARNING] $Message" -ForegroundColor $YELLOW
}

function Write-LogError {
    param([string]$Message)
    Write-Host "[ERROR] $Message" -ForegroundColor $RED
}

function Show-Help {
    Write-Host "Enhanced Finfluencer Tracker Docker Update Script with Version Management (PowerShell)" -ForegroundColor $GREEN
    Write-Host ""
    Write-Host "Usage: $PSCommandPath [version] [options]"
    Write-Host ""
    Write-Host "Parameters:"
    Write-Host "  -Version <version>       Specific version tag (e.g., v1.1.0)"
    Write-Host "                          Bump type: 'major', 'minor', 'patch'"
    Write-Host "                          If omitted, auto-generates timestamp version"
    Write-Host ""
    Write-Host "Switches:"
    Write-Host "  -SkipTest               Skip local testing after build"
    Write-Host "  -CleanupOnly            Only clean up old Docker images"
    Write-Host "  -SyncVersions           Sync versions across all project files"
    Write-Host "  -NoGit                  Skip Git tagging and commits"
    Write-Host "  -KeepVersions <N>       Keep last N versions (default: 5)"
    Write-Host "  -Help, -?               Show this help message"
    Write-Host ""
    Write-Host "Examples:"
    Write-Host "  $PSCommandPath                           # Auto version with timestamp"
    Write-Host "  $PSCommandPath -Version v1.1.0           # Specific version"
    Write-Host "  $PSCommandPath -Version minor            # Bump minor version"
    Write-Host "  $PSCommandPath -Version patch            # Bump patch version"
    Write-Host "  $PSCommandPath -CleanupOnly              # Clean up old images only"
    Write-Host "  $PSCommandPath -Version v1.2.0 -SkipTest # Skip local testing"
    Write-Host "  $PSCommandPath -KeepVersions 3           # Keep only last 3 versions"
    Write-Host ""
    Write-Host "Environment:"
    Write-Host "  Uses .env file for environment variables"
    Write-Host "  DockerHub username: $DOCKERHUB_USERNAME"
}

function Generate-Version {
    return "v$(Get-Date -Format 'yyyyMMdd-HHmmss')"
}

function Get-CurrentVersion {
    if (Test-Path $PACKAGE_JSON) {
        $content = Get-Content $PACKAGE_JSON -Raw
        if ($content -match '"version":\s*"([^"]+)"') {
            return $matches[1]
        }
    }
    return "1.0.0"
}

function Bump-Version {
    param(
        [string]$CurrentVersion,
        [string]$BumpType
    )
    
    # Remove 'v' prefix if present
    $CurrentVersion = $CurrentVersion -replace '^v', ''
    
    # Parse version
    $versionParts = $CurrentVersion -split '\.'
    $major = [int]$versionParts[0]
    $minor = [int]$versionParts[1]
    $patch = [int]$versionParts[2]
    
    switch ($BumpType.ToLower()) {
        "major" {
            $major++
            $minor = 0
            $patch = 0
        }
        "minor" {
            $minor++
            $patch = 0
        }
        "patch" {
            $patch++
        }
        default {
            Write-LogError "Invalid bump type: $BumpType. Use 'major', 'minor', or 'patch'"
            exit 1
        }
    }
    
    return "v$major.$minor.$patch"
}

function Update-PackageJson {
    param([string]$NewVersion)
    
    $NewVersion = $NewVersion -replace '^v', ''  # Remove v prefix for package.json
    
    if (Test-Path $PACKAGE_JSON) {
        Write-LogInfo "Updating package.json version to $NewVersion"
        $content = Get-Content $PACKAGE_JSON -Raw
        $updatedContent = $content -replace '"version":\s*"[^"]*"', "`"version`": `"$NewVersion`""
        Set-Content -Path $PACKAGE_JSON -Value $updatedContent -NoNewline
        Write-LogSuccess "Updated package.json"
    } else {
        Write-LogWarning "package.json not found, skipping update"
    }
}

function Update-VersionTs {
    param([string]$NewVersion)
    
    if (Test-Path $VERSION_FILE) {
        Write-LogInfo "Updating src/version.ts version to $NewVersion"
        
        # Extract major, minor, patch from version
        $NewVersion = $NewVersion -replace '^v', ''  # Remove v prefix
        $versionParts = $NewVersion -split '\.'
        $major = [int]$versionParts[0]
        $minor = [int]$versionParts[1]
        $patch = [int]$versionParts[2]
        $buildDate = Get-Date -Format "yyyy-MM-ddTHH:mm:ss.fffZ"
        
        $content = Get-Content $VERSION_FILE -Raw
        
        # Update version.ts using regex replacements
        $content = $content -replace "version: '[^']*'", "version: '$NewVersion'"
        $content = $content -replace "major: [0-9]*", "major: $major"
        $content = $content -replace "minor: [0-9]*", "minor: $minor"
        $content = $content -replace "patch: [0-9]*", "patch: $patch"
        $content = $content -replace "buildDate: '[^']*'", "buildDate: '$buildDate'"
        
        Set-Content -Path $VERSION_FILE -Value $content -NoNewline
        Write-LogSuccess "Updated src/version.ts"
    } else {
        Write-LogWarning "src/version.ts not found, skipping update"
    }
}

function Commit-Changes {
    param(
        [string]$Version,
        [string]$Message
    )
    
    if (-not $Message) {
        $Message = "Update to version $Version"
    }
    
    $gitStatus = git rev-parse --git-dir 2>$null
    if ($gitStatus) {
        Write-LogInfo "Committing changes to Git"
        git add . 2>$null
        git commit -m $Message 2>$null
        if ($LASTEXITCODE -eq 0) {
            git tag $Version 2>$null
        } else {
            Write-LogWarning "No changes to commit"
        }
        Write-LogSuccess "Committed and tagged version $Version"
    } else {
        Write-LogWarning "Not a Git repository, skipping commit and tag"
    }
}

function Push-ToGit {
    param([string]$Version)
    
    $gitStatus = git rev-parse --git-dir 2>$null
    if ($gitStatus) {
        Write-LogInfo "Pushing to Git"
        git push origin 2>$null
        git push origin $Version 2>$null
        Write-LogSuccess "Pushed to Git"
    }
}

function Test-EnvFile {
    if (-not (Test-Path $ENV_FILE)) {
        Write-LogError "Environment file '$ENV_FILE' not found!"
        Write-Host "Please ensure you have a .env file with your configuration."
        exit 1
    }
    Write-LogInfo "Found environment file: $ENV_FILE"
}

function Validate-EnvFile {
    Write-LogInfo "Validating .env file format..."
    
    # Check for common .env format issues
    $content = Get-Content $ENV_FILE -Raw
    if ($content -match '\s+=\s+') {
        Write-LogWarning "Found variables with spaces around equals sign"
        Write-LogInfo "Variables should use format: VARIABLE=value (no spaces around =)"
    }
    
    if ($content -match '\s+=\s+["''].*["'']\s*$') {
        Write-LogWarning "Found variables with quotes around values"
        Write-LogInfo "Variables should use format: VARIABLE=value (no quotes needed)"
    }
    
    Write-LogSuccess "Environment file validation complete"
}

function Build-Image {
    param([string]$Version)
    
    $imageTag = "$LOCAL_IMAGE_NAME`:$Version"
    $latestTag = "$LOCAL_IMAGE_NAME`:latest"
    Write-LogInfo "Building Docker image: $imageTag"
    
    & docker build -t $imageTag .
    & docker tag $imageTag $latestTag
    
    if ($LASTEXITCODE -eq 0) {
        Write-LogSuccess "Docker image built successfully"
    } else {
        Write-LogError "Docker build failed"
        exit 1
    }
}

function Test-Image {
    param([string]$Version)
    
    $imageTag = "$LOCAL_IMAGE_NAME`:$Version"
    Write-LogInfo "Testing Docker image locally..."
    
    $testOutput = & docker run --env-file $ENV_FILE $imageTag 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-LogSuccess "Local test passed!"
        return $true
    } else {
        Write-LogError "Local test failed!"
        Write-LogInfo "Test output:"
        Write-Host $testOutput
        return $false
    }
}

function Push-ToHub {
    param([string]$Version)
    
    $localImage = "$LOCAL_IMAGE_NAME`:$Version"
    $remoteImage = "$IMAGE_NAME`:$Version"
    $latestTag = "$IMAGE_NAME`:latest"
    $localLatest = "$LOCAL_IMAGE_NAME`:latest"
    
    Write-LogInfo "Pushing to DockerHub: $remoteImage"
    
    # Push specific version
    & docker tag $localImage $remoteImage
    & docker push $remoteImage
    
    # Push latest tag
    & docker tag $localLatest $latestTag
    & docker push $latestTag
    
    if ($LASTEXITCODE -eq 0) {
        Write-LogSuccess "Successfully pushed to DockerHub"
    } else {
        Write-LogError "Failed to push to DockerHub"
        exit 1
    }
}

function Cleanup-Images {
    param([int]$KeepCount)
    
    Write-LogInfo "Cleaning up old Docker images (keeping last $KeepCount versions)..."
    
    # Get list of our image versions
    $versions = & docker images $IMAGE_NAME --format "{{.Tag}}" | Where-Object { $_ -match "^v[0-9]{8}-[0-9]{6}$|^v[0-9]+\.[0-9]+\.[0-9]+$" } | Sort-Object -Descending
    
    if ($versions.Count -gt $KeepCount) {
        $toRemove = $versions | Select-Object -Skip $KeepCount
        
        Write-LogInfo "Found $($versions.Count) versions, removing $($toRemove.Count) old versions:"
        foreach ($version in $toRemove) {
            $imageToRemove = "$IMAGE_NAME`:$version"
            Write-LogInfo "Removing: $imageToRemove"
            & docker rmi $imageToRemove 2>$null
            if ($LASTEXITCODE -ne 0) {
                Write-LogWarning "Could not remove $imageToRemove"
            }
        }
        
        # Also cleanup dangling images
        Write-LogInfo "Cleaning up dangling images..."
        & docker image prune -f 2>$null
        
        Write-LogSuccess "Cleanup completed"
    } else {
        Write-LogInfo "No old versions to remove (current: $($versions.Count), keep: $KeepCount)"
    }
}

function Test-DockerLogin {
    $dockerInfo = & docker info 2>$null
    if ($dockerInfo -notmatch "Username:\s*$DOCKERHUB_USERNAME") {
        Write-LogWarning "Not logged in to DockerHub as $DOCKERHUB_USERNAME"
        Write-LogInfo "Please run: docker login"
        return $false
    }
    Write-LogSuccess "DockerHub login verified"
    return $true
}

# Main execution
function Main {
    # Show help if requested
    if ($Help) {
        Show-Help
        exit 0
    }
    
    # Determine bump type if version is a keyword
    $bumpType = $null
    $actualVersion = $Version
    
    if ($Version -match "^(major|minor|patch)$") {
        $bumpType = $Version.ToLower()
        $actualVersion = $null
    }
    
    # Set defaults
    if ($SyncVersions -eq $false -and -not $bumpType) {
        $SyncVersions = $true  # Default to syncing versions
    }
    
    # Header
    Write-Host "========================================================" -ForegroundColor $GREEN
    Write-Host "🚀 Enhanced Finfluencer Tracker Docker Update Script" -ForegroundColor $GREEN
    Write-Host "========================================================" -ForegroundColor $GREEN
    Write-LogInfo "DockerHub Username: $DOCKERHUB_USERNAME"
    Write-LogInfo "Image Name: $IMAGE_NAME"
    Write-LogInfo "Sync Versions: $SyncVersions"
    
    # If cleanup only mode
    if ($CleanupOnly) {
        Test-EnvFile
        Validate-EnvFile
        Cleanup-Images -KeepCount $KeepVersions
        return
    }
    
    # Check environment
    Test-EnvFile
    Validate-EnvFile
    
    # Check Docker login only if not using -NoGit
    if (-not $NoGit) {
        if (-not (Test-DockerLogin)) {
            exit 1
        }
    }
    
    # Determine version
    if ($bumpType) {
        $currentVersion = Get-CurrentVersion
        $actualVersion = Bump-Version -CurrentVersion $currentVersion -BumpType $bumpType
        Write-LogInfo "Bumping $bumpType version: $currentVersion → $actualVersion"
    } elseif ($actualVersion) {
        Write-LogInfo "Using specified version: $actualVersion"
    } else {
        $actualVersion = Generate-Version
        Write-LogInfo "Auto-generated version: $actualVersion"
    }
    
    # Sync versions across files if requested
    if ($SyncVersions) {
        Write-LogInfo "🔄 Synchronizing versions across project files..."
        
        Update-PackageJson -NewVersion $actualVersion
        Update-VersionTs -NewVersion $actualVersion
        
        if (-not $NoGit) {
            Commit-Changes -Version $actualVersion
        }
        
        Write-LogSuccess "✅ Version synchronization completed"
    }
    
    # Build, test, and push (only if not using -NoGit)
    if (-not $NoGit) {
        Build-Image -Version $actualVersion
        
        if (-not $SkipTest) {
            if (-not (Test-Image -Version $actualVersion)) {
                Write-LogError "Build failed during testing. Aborting push."
                exit 1
            }
        } else {
            Write-LogWarning "Skipping local test (-SkipTest flag used)"
        }
        
        Push-ToHub -Version $actualVersion
        
        # Push to Git if not skipped
        if (-not $NoGit) {
            Push-ToGit -Version $actualVersion
        }
        
        # Cleanup old images
        Cleanup-Images -KeepCount $KeepVersions
    }
    
    # Show final state
    Write-LogSuccess "🎉 Enhanced update completed successfully!"
    Write-Host ""
    Write-LogInfo "Version: $actualVersion"
    if (-not $NoGit) {
        Write-LogInfo "DockerHub: $IMAGE_NAME`:$actualVersion"
    }
    Write-LogInfo "Updated files: package.json, src/version.ts"
    
    if (-not $NoGit) {
        Write-Host ""
        Write-LogInfo "To run the new version:"
        $runCommand = "docker run --env-file .env $IMAGE_NAME`:latest"
        Write-Host $runCommand
    }
}

# Run main function
Main
