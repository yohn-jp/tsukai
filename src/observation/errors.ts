export class ObservationError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class HarnessProtocolError extends ObservationError {
  constructor(message: string, code = "HARNESS_PROTOCOL_ERROR") {
    super(message, code);
  }
}

export class JournalError extends ObservationError {}

export class JournalClosedError extends JournalError {
  constructor() {
    super("Observation journal is closed", "JOURNAL_CLOSED");
  }
}

export class JournalGapError extends JournalError {
  constructor(
    readonly runId: string,
    readonly requestedAfter: number,
    readonly retainedFrom: number,
  ) {
    super(
      `Observation history gap for ${runId}: requested after ${requestedAfter}, retained from ${retainedFrom}`,
      "JOURNAL_GAP",
    );
  }
}

export class JournalOverflowError extends JournalError {
  constructor(readonly runId: string) {
    super(
      `Observation subscriber queue overflow for ${runId}`,
      "JOURNAL_OVERFLOW",
    );
  }
}

export class JournalCapacityError extends JournalError {
  constructor(message: string, code = "JOURNAL_CAPACITY") {
    super(message, code);
  }
}

export class JournalValidationError extends JournalError {
  constructor(message: string) {
    super(message, "JOURNAL_VALIDATION");
  }
}
