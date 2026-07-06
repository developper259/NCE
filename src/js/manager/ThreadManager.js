class ThreadManager {
  constructor() {
    this.workers = new Map();
    this.taskQueue = new Map();
    this.maxWorkers = navigator.hardwareConcurrency || 4;
    this.workerCounter = 0;
  }

  createWorker(workerPath, name) {
    if (this.workers.size >= this.maxWorkers) {
      console.warn(
        `Max workers (${this.maxWorkers}) reached. Reusing existing workers.`,
      );
      return this.getAvailableWorker();
    }

    const workerId = `worker-${this.workerCounter++}`;
    const worker = new Worker(workerPath);

    worker.onmessage = (e) => this.handleWorkerMessage(workerId, e);
    worker.onerror = (e) => this.handleWorkerError(workerId, e);

    this.workers.set(workerId, {
      worker,
      name,
      busy: false,
      task: null,
    });

    console.log(`Worker ${workerId} (${name}) created`);
    return workerId;
  }

  getAvailableWorker() {
    for (const [workerId, workerData] of this.workers) {
      if (!workerData.busy) {
        return workerId;
      }
    }
    return null;
  }

  executeTask(workerPath, taskName, data, transferables = []) {
    return new Promise((resolve, reject) => {
      let workerId = this.getAvailableWorker();

      if (!workerId) {
        workerId = this.createWorker(workerPath, taskName);
      }

      const taskId = `${taskName}-${Date.now()}-${Math.random()}`;

      this.taskQueue.set(taskId, {
        resolve,
        reject,
        workerId,
        taskName,
      });

      const workerData = this.workers.get(workerId);
      workerData.busy = true;
      workerData.task = taskId;

      try {
        workerData.worker.postMessage(
          {
            taskId,
            taskName,
            data,
          },
          transferables,
        );
      } catch (error) {
        this.cleanupTask(taskId);
        reject(error);
      }
    });
  }

  handleWorkerMessage(workerId, event) {
    const { taskId, result, error } = event.data;
    const task = this.taskQueue.get(taskId);

    if (!task) {
      console.warn(`Task ${taskId} not found in queue`);
      return;
    }

    const workerData = this.workers.get(workerId);
    if (workerData) {
      workerData.busy = false;
      workerData.task = null;
    }

    this.taskQueue.delete(taskId);

    if (error) {
      task.reject(new Error(error));
    } else {
      task.resolve(result);
    }
  }

  handleWorkerError(workerId, error) {
    console.error(`Worker ${workerId} error:`, error);

    const workerData = this.workers.get(workerId);
    if (workerData && workerData.task) {
      const task = this.taskQueue.get(workerData.task);
      if (task) {
        task.reject(error);
        this.taskQueue.delete(workerData.task);
      }
    }

    this.terminateWorker(workerId);
  }

  terminateWorker(workerId) {
    const workerData = this.workers.get(workerId);
    if (workerData) {
      workerData.worker.terminate();
      this.workers.delete(workerId);
      console.log(`Worker ${workerId} terminated`);
    }
  }

  terminateAll() {
    for (const [workerId] of this.workers) {
      this.terminateWorker(workerId);
    }
    this.taskQueue.clear();
  }

  cleanupTask(taskId) {
    const task = this.taskQueue.get(taskId);
    if (task) {
      const workerData = this.workers.get(task.workerId);
      if (workerData) {
        workerData.busy = false;
        workerData.task = null;
      }
      this.taskQueue.delete(taskId);
    }
  }

  getWorkerCount() {
    return this.workers.size;
  }

  getBusyWorkerCount() {
    let count = 0;
    for (const workerData of this.workers.values()) {
      if (workerData.busy) count++;
    }
    return count;
  }

  getWorkerStatus() {
    const status = [];
    for (const [workerId, workerData] of this.workers) {
      status.push({
        id: workerId,
        name: workerData.name,
        busy: workerData.busy,
        task: workerData.task,
      });
    }
    return status;
  }
}
