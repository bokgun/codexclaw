export class RuntimeError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message);
  }
}

export class CapabilityError extends RuntimeError {
  constructor(message: string) {
    super(message, "capability_unavailable");
  }
}

export class RoutingError extends RuntimeError {
  constructor(message: string, code = "routing_error") {
    super(message, code);
  }
}
