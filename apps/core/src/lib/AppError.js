// src/core/AppError.js
export class AppError extends Error {
    constructor(statusCode, errorCode, isOperational = true) {
        super(errorCode);
        this.statusCode = statusCode;
        this.errorCode = errorCode;
        this.isOperational = isOperational;
        Error.captureStackTrace(this, this.constructor);
    }
}