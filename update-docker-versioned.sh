#!/bin/bash

# Enhanced Finfluencer Tracker Docker Update Script with Version Management
# Usage: ./update-docker-versioned.sh [version] [options]
# Examples:
#   ./update-docker-versioned.sh                 # Auto-generates version
#   ./update-docker-versioned.sh v1.1.0          # Specific version
#   ./update-docker-versioned.sh minor           # Bump minor version
#   ./update-docker-versioned.sh patch           # Bump patch version
#   ./update-docker-versioned.sh --cleanup-only  # Just cleanup old images
#   ./update-docker-versioned.sh --help          # Show help

set -e  # Exit on any error

# Configuration
DOCKERHUB_USERNAME="sercanhub"
IMAGE_NAME="$DOCKERHUB_USERNAME/finfluencer-tracker"
LOCAL_IMAGE_NAME="finfluencer-tracker"
ENV_FILE=".env"
PACKAGE_JSON="package.json"
VERSION_FILE="src/version.ts"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Function to display help
show_help() {
    echo "Enhanced Finfluencer Tracker Docker Update Script with Version Management"
    echo ""
    echo "Usage: $0 [version] [options]"
    echo ""
    echo "Arguments:"
    echo "  version              Specific version tag (e.g., v1.1.0)"
    echo "                      Bump type: 'major', 'minor', 'patch'"
    echo "                      If omitted, auto-generates timestamp version"
    echo ""
    echo "Options:"
    echo "  --sync-versions      Sync versions across package.json, version.ts, and Docker"
    echo "  --skip-test          Skip local testing after build"
    echo "  --cleanup-only       Only clean up old Docker images"
    echo "  --keep-versions N    Keep last N versions (default: 5)"
    echo "  --no-git             Skip Git tagging and commit"
    echo "  --help, -h           Show this help message"
    echo ""
    echo "Examples:"
    echo "  $0                           # Auto version with timestamp"
    echo "  $0 v1.1.0                    # Specific version"
    echo "  $0 minor                     # Bump minor version"
    echo "  $0 patch                     # Bump patch version"
    echo "  $0 --cleanup-only            # Clean up old images only"
    echo "  $0 v1.2.0 --skip-test        # Skip local testing"
    echo "  $0 --keep-versions 3         # Keep only last 3 versions"
    echo ""
    echo "Environment:"
    echo "  Uses .env file for environment variables"
    echo "  DockerHub username: $DOCKERHUB_USERNAME"
}

# Function to generate version
generate_version() {
    echo "v$(date +%Y%m%d-%H%M%S)"
}

# Function to get current version from package.json
get_current_version() {
    if [ -f "$PACKAGE_JSON" ]; then
        grep '"version"' "$PACKAGE_JSON" | sed 's/.*"version": *"\([^"]*\)".*/\1/'
    else
        echo "1.0.0"
    fi
}

# Function to bump version
bump_version() {
    local current_version=$1
    local bump_type=$2
    
    # Remove 'v' prefix if present
    current_version=${current_version#v}
    
    # Parse version
    IFS='.' read -ra VERSION_PARTS <<< "$current_version"
    major=${VERSION_PARTS[0]:-1}
    minor=${VERSION_PARTS[1]:-0}
    patch=${VERSION_PARTS[2]:-0}
    
    case $bump_type in
        major)
            major=$((major + 1))
            minor=0
            patch=0
            ;;
        minor)
            minor=$((minor + 1))
            patch=0
            ;;
        patch)
            patch=$((patch + 1))
            ;;
        *)
            log_error "Invalid bump type: $bump_type. Use 'major', 'minor', or 'patch'"
            exit 1
            ;;
    esac
    
    echo "v$major.$minor.$patch"
}

# Function to update package.json version
update_package_json() {
    local new_version=$1
    new_version=${new_version#v}  # Remove v prefix for package.json
    
    if [ -f "$PACKAGE_JSON" ]; then
        log_info "Updating package.json version to $new_version"
        if command -v jq >/dev/null 2>&1; then
            jq --arg version "$new_version" '.version = $version' "$PACKAGE_JSON" > "$PACKAGE_JSON.tmp"
            mv "$PACKAGE_JSON.tmp" "$PACKAGE_JSON"
        else
            # Fallback using sed
            sed -i.bak "s/\"version\": *\"[^\"]*\"/\"version\": \"$new_version\"/" "$PACKAGE_JSON"
            rm -f "$PACKAGE_JSON.bak"
        fi
        log_success "Updated package.json"
    else
        log_warning "package.json not found, skipping update"
    fi
}

# Function to update version.ts file
update_version_ts() {
    local new_version=$1
    
    if [ -f "$VERSION_FILE" ]; then
        log_info "Updating src/version.ts version to $new_version"
        
        # Extract major, minor, patch from version
        new_version=${new_version#v}  # Remove v prefix
        IFS='.' read -ra VERSION_PARTS <<< "$new_version"
        major=${VERSION_PARTS[0]:-1}
        minor=${VERSION_PARTS[1]:-0}
        patch=${VERSION_PARTS[2]:-0}
        build_date=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
        
        # Update version.ts using sed
        sed -i.bak \
            -e "s/version: '[^']*'/version: '$new_version'/" \
            -e "s/major: [0-9]*/major: $major/" \
            -e "s/minor: [0-9]*/minor: $minor/" \
            -e "s/patch: [0-9]*/patch: $patch/" \
            -e "s/buildDate: '[^']*'/buildDate: '$build_date'/" \
            "$VERSION_FILE"
        rm -f "$VERSION_FILE.bak"
        log_success "Updated src/version.ts"
    else
        log_warning "src/version.ts not found, skipping update"
    fi
}

# Function to commit changes
commit_changes() {
    local version=$1
    local message=${2:-"Update to version $version"}
    
    if git rev-parse --git-dir > /dev/null 2>&1; then
        log_info "Committing changes to Git"
        git add .
        git commit -m "$message" || log_warning "No changes to commit"
        git tag "$version" || log_warning "Tag $version already exists"
        log_success "Committed and tagged version $version"
    else
        log_warning "Not a Git repository, skipping commit and tag"
    fi
}

# Function to push to Git
push_to_git() {
    local version=$1
    
    if git rev-parse --git-dir > /dev/null 2>&1; then
        log_info "Pushing to Git"
        git push origin
        git push origin "$version" 2>/dev/null || log_warning "Tag $version already pushed"
        log_success "Pushed to Git"
    fi
}

# Function to validate .env file format
validate_env_file() {
    log_info "Validating .env file format..."
    
    # Check for common .env format issues
    if grep -qE '^\s*[A-Z_]+\s*=\s*[^\s].*' "$ENV_FILE" 2>/dev/null; then
        log_warning "Found variables with spaces around equals sign"
        log_info "Variables should use format: VARIABLE=value (no spaces around =)"
    fi
    
    if grep -qE '^\s*[A-Z_]+\s*=\s*["\047].*["\047]\s*$' "$ENV_FILE" 2>/dev/null; then
        log_warning "Found variables with quotes around values"
        log_info "Variables should use format: VARIABLE=value (no quotes needed)"
    fi
    
    log_success "Environment file validation complete"
}

# Function to build Docker image
build_image() {
    local version=$1
    log_info "Building Docker image: $LOCAL_IMAGE_NAME:$version"
    
    docker build -t "$LOCAL_IMAGE_NAME:$version" .
    docker tag "$LOCAL_IMAGE_NAME:$version" "$LOCAL_IMAGE_NAME:latest"
    
    log_success "Docker image built successfully"
}

# Function to test image locally
test_image() {
    local version=$1
    log_info "Testing Docker image locally..."
    
    if docker run --env-file "$ENV_FILE" "$LOCAL_IMAGE_NAME:$version" > /tmp/docker_test.log 2>&1; then
        log_success "Local test passed!"
        return 0
    else
        log_error "Local test failed!"
        log_info "Test output:"
        cat /tmp/docker_test.log
        return 1
    fi
}

# Function to push to DockerHub
push_to_hub() {
    local version=$1
    log_info "Pushing to DockerHub: $IMAGE_NAME:$version"
    
    # Push specific version
    docker tag "$LOCAL_IMAGE_NAME:$version" "$IMAGE_NAME:$version"
    docker push "$IMAGE_NAME:$version"
    
    # Push latest tag
    docker tag "$LOCAL_IMAGE_NAME:latest" "$IMAGE_NAME:latest"
    docker push "$IMAGE_NAME:latest"
    
    log_success "Successfully pushed to DockerHub"
}

# Function to cleanup old images
cleanup_images() {
    local keep_versions=${1:-5}
    
    log_info "Cleaning up old Docker images (keeping last $keep_versions versions)..."
    
    # Get list of our image versions, sorted by creation date (newest first)
    local versions=($(docker images "$IMAGE_NAME" --format "{{.Tag}}" | grep -E "^v[0-9]{8}-[0-9]{6}$|^v[0-9]+\.[0-9]+\.[0-9]+$" | sort -r))
    
    if [ ${#versions[@]} -gt $keep_versions ]; then
        local to_remove=("${versions[@]:$keep_versions}")
        
        log_info "Found ${#versions[@]} versions, removing ${#to_remove[@]} old versions:"
        for version in "${to_remove[@]}"; do
            log_info "Removing: $version"
            docker rmi "$IMAGE_NAME:$version" 2>/dev/null || log_warning "Could not remove $IMAGE_NAME:$version"
        done
        
        # Also cleanup dangling images
        log_info "Cleaning up dangling images..."
        docker image prune -f >/dev/null 2>&1 || true
        
        log_success "Cleanup completed"
    else
        log_info "No old versions to remove (current: ${#versions[@]}, keep: $keep_versions)"
    fi
}

# Function to check if .env file exists
check_env_file() {
    if [ ! -f "$ENV_FILE" ]; then
        log_error "Environment file '$ENV_FILE' not found!"
        echo "Please ensure you have a .env file with your configuration."
        exit 1
    fi
    log_info "Found environment file: $ENV_FILE"
}

# Function to verify DockerHub login
check_docker_login() {
    if ! docker info | grep -q "Username: $DOCKERHUB_USERNAME"; then
        log_warning "Not logged in to DockerHub as $DOCKERHUB_USERNAME"
        log_info "Please run: docker login"
        return 1
    fi
    log_success "DockerHub login verified"
    return 0
}

# Main execution
main() {
    local version=""
    local bump_type=""
    local skip_test=false
    local cleanup_only=false
    local keep_versions=5
    local sync_versions=true
    local no_git=false
    
    # Parse arguments
    while [[ $# -gt 0 ]]; do
        case $1 in
            --help|-h)
                show_help
                exit 0
                ;;
            --skip-test)
                skip_test=true
                shift
                ;;
            --cleanup-only)
                cleanup_only=true
                shift
                ;;
            --sync-versions)
                sync_versions=true
                shift
                ;;
            --no-git)
                no_git=true
                shift
                ;;
            --keep-versions)
                keep_versions="$2"
                shift 2
                ;;
            major|minor|patch)
                bump_type="$1"
                shift
                ;;
            -*)
                log_error "Unknown option: $1"
                show_help
                exit 1
                ;;
            *)
                version="$1"
                shift
                ;;
        esac
    done
    
    # Header
    echo "========================================================"
    echo "🚀 Enhanced Finfluencer Tracker Docker Update Script"
    echo "========================================================"
    log_info "DockerHub Username: $DOCKERHUB_USERNAME"
    log_info "Image Name: $IMAGE_NAME"
    log_info "Sync Versions: $sync_versions"
    
    # If cleanup only mode
    if [ "$cleanup_only" = true ]; then
        check_env_file
        validate_env_file
        cleanup_images "$keep_versions"
        exit 0
    fi
    
    # Check environment
    check_env_file
    validate_env_file
    check_docker_login || exit 1
    
    # Determine version
    if [ -n "$bump_type" ]; then
        local current_version=$(get_current_version)
        version=$(bump_version "$current_version" "$bump_type")
        log_info "Bumping $bump_type version: $current_version → $version"
    elif [ -n "$version" ]; then
        log_info "Using specified version: $version"
    else
        version=$(generate_version)
        log_info "Auto-generated version: $version"
    fi
    
    # Sync versions across files if requested
    if [ "$sync_versions" = true ]; then
        log_info "🔄 Synchronizing versions across project files..."
        
        update_package_json "$version"
        update_version_ts "$version"
        
        if [ "$no_git" = false ]; then
            commit_changes "$version"
        fi
        
        log_success "✅ Version synchronization completed"
    fi
    
    # Build, test, and push
    build_image "$version"
    
    if [ "$skip_test" = false ]; then
        if ! test_image "$version"; then
            log_error "Build failed during testing. Aborting push."
            exit 1
        fi
    else
        log_warning "Skipping local test (--skip-test flag used)"
    fi
    
    push_to_hub "$version"
    
    # Push to Git if not skipped
    if [ "$no_git" = false ]; then
        push_to_git "$version"
    fi
    
    # Cleanup old images
    cleanup_images "$keep_versions"
    
    # Show final state
    log_success "🎉 Enhanced update completed successfully!"
    echo ""
    log_info "Version: $version"
    log_info "DockerHub: $IMAGE_NAME:$version"
    log_info "Updated files: package.json, src/version.ts"
    
    echo ""
    log_info "To run the new version:"
    echo "docker run --env-file .env $IMAGE_NAME:latest"
}

# Run main function
main "$@"
