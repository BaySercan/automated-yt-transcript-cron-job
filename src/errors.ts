export class DatabaseError extends Error {
  public code?: string;
  public details?: any;

  constructor(message: string, options?: { code?: string; cause?: any }) {
    super(message);
    this.name = 'DatabaseError';
    this.code = options?.code;
    this.details = options?.cause;
  }
}

export class YouTubeError extends Error {
  public code?: number;
  public response?: any;

  constructor(message: string, options?: { code?: number; cause?: any }) {
    super(message);
    this.name = 'YouTubeError';
    this.code = options?.code;
    this.response = options?.cause;
  }
}

export class OpenRouterError extends Error {
  public status?: number;
  public data?: any;

  constructor(message: string, options?: { status?: number; cause?: any }) {
    super(message);
    this.name = 'OpenRouterError';
    this.status = options?.status;
    this.data = options?.cause;
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

export class TranscriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TranscriptError';
  }
}

export class AnalysisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalysisError';
  }
}
