export class DomainError extends Error {
  constructor(message, { code = 'domain_error', statusCode = 400, details = null } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export class ValidationError extends DomainError {
  constructor(message, options = {}) {
    super(message, { code: 'validation_error', statusCode: 400, ...options });
  }
}

export class NotFoundError extends DomainError {
  constructor(message, options = {}) {
    super(message, { code: 'not_found', statusCode: 404, ...options });
  }
}

export class ConflictError extends DomainError {
  constructor(message, options = {}) {
    super(message, { code: 'conflict', statusCode: 409, ...options });
  }
}

export class AdapterUnavailableError extends DomainError {
  constructor(message, options = {}) {
    super(message, { code: 'adapter_unavailable', statusCode: 503, ...options });
  }
}
