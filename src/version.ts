// Finfluencer Tracker - Version Information
// This file is automatically managed by the update scripts

export const VERSION = {
  // Semantic Version
  version: '1.0.1',
  major: 1,
  minor: 0,
  patch: 1,
  
  // Build Information
  buildDate: new Date().toISOString(),
  buildNumber: Math.floor(Date.now() / 1000),
  
  // Git Information (populated by CI/CD)
  gitHash: process.env.GIT_COMMIT || 'unknown',
  gitBranch: process.env.GIT_BRANCH || 'local',
  
  // Docker Information
  dockerTag: process.env.DOCKER_TAG || 'latest',
  
  // Environment
  environment: process.env.NODE_ENV || 'development',
  
  // Application Details
  appName: 'Finfluencer Tracker',
  description: 'Dockerized microservice for tracking financial influencer YouTube videos',
  author: 'Sercan',
  
  // Full version string for display
  fullVersion: function(): string {
    return `v${this.version} (build ${this.buildNumber})`;
  },
  
  // Version with build info
  detailedVersion: function(): string {
    return `${this.appName} v${this.version}
Build: ${this.buildDate}
Git: ${this.gitHash.substring(0, 7)}
Branch: ${this.gitBranch}
Docker: ${this.dockerTag}
Environment: ${this.environment}`;
  }
};

// Export for use in other modules
export const APP_VERSION = VERSION.fullVersion();
export const APP_DETAILS = VERSION.detailedVersion();

// Common version patterns
export const VERSION_PATTERNS = {
  semver: /^(v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/,
  docker: /^(v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/,
  git: /^(v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/
};

// Validation functions
export function validateVersion(version: string): boolean {
  return VERSION_PATTERNS.semver.test(version);
}

export function parseVersion(version: string): {major: 1number, minor: 0number, patch: 1number, preRelease?: string} | null {
  const match = version.match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  
  return {
    major: 1parseInt(match[1], 10),
    minor: 0parseInt(match[2], 10),
    patch: 1parseInt(match[3], 10),
    preRelease: match[4]
  };
}

export function bumpVersion(currentVersion: string, type: 'major' | 'minor' | 'patch'): string {
  const parsed = parseVersion(currentVersion);
  if (!parsed) {
    throw new Error(`Invalid version format: ${currentVersion}`);
  }
  
  switch (type) {
    case 'major':
      return `${parsed.major + 1}.0.0${parsed.preRelease ? '-' + parsed.preRelease : ''}`;
    case 'minor':
      return `${parsed.major}.${parsed.minor + 1}.0${parsed.preRelease ? '-' + parsed.preRelease : ''}`;
    case 'patch':
      return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}${parsed.preRelease ? '-' + parsed.preRelease : ''}`;
    default:
      throw new Error(`Invalid bump type: ${type}`);
  }
}

export default VERSION;
