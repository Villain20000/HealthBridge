# Security Policy

## Reporting Security Vulnerabilities

If you discover a security vulnerability or sensitive data exposure in HealthBridge OS, please report it directly to security@healthbridge-os.org.

Do not create public GitHub issues for undisclosed security vulnerabilities.

## PII & Data Privacy

- HealthBridge OS redacts sensitive patient attributes (SSNs, emails, phone numbers) by default in trace logs.
- Never include raw production patient health data (PHI) in test fixtures or GitHub pull requests. Always use synthetic data.
