export class DeterministicRemoteSession {
  epoch = "1";
  state = "ready";
  available = true;
  acceptingAssignments = true;
  resultAcknowledgements = [];
  #listeners = new Set();
  #stateListeners = new Set();
  #sequence = 0;

  onMessage(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onStateChange(listener) {
    this.#stateListeners.add(listener);
    return () => this.#stateListeners.delete(listener);
  }

  async request(type, payload) {
    const correlationId = `request-${this.#sequence++}`;
    const messageId = `response-${this.#sequence++}`;
    if (type === "session.reconcile") {
      return {
        messageId,
        correlationId,
        type,
        payload: {
          acknowledged: [],
          attemptPersistenceAvailable: true,
          componentActivations: [],
          epoch: this.epoch,
          preparedArtifacts: [],
          running: [],
          terminalUnacknowledged: [],
        },
      };
    }
    if (type === "task.assign") {
      return {
        messageId,
        correlationId,
        type: "task.acknowledge",
        payload: {
          accepted: true,
          attemptId: payload.request.attemptId,
          taskId: payload.request.taskId,
        },
      };
    }
    throw new Error(`Unexpected deterministic request: ${type}`);
  }

  async send(type, payload, options = {}) {
    const messageId = `sent-${this.#sequence++}`;
    if (type === "task.acknowledge" && payload.kind === "result") {
      this.resultAcknowledgements.push({
        attemptId: payload.attemptId,
        correlationId: options.correlationId ?? messageId,
        taskId: payload.taskId,
      });
    }
    return messageId;
  }

  emitResult(result, suffix) {
    const message = {
      messageId: `remote-result-${suffix}`,
      correlationId: `remote-result-${suffix}`,
      type: "task.result",
      payload: { result },
    };
    for (const listener of this.#listeners) listener(message);
  }

  close() {
    this.state = "closed";
    this.available = false;
    this.acceptingAssignments = false;
    for (const listener of this.#stateListeners) listener(this.state);
  }
}
