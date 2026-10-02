export interface TickOptions { force?: boolean }

export interface OccupancySource {
  start(): void;
  stop(): Promise<void>;
  tick(options?: TickOptions): Promise<void>;
}

export class StaticOccupancySource implements OccupancySource {
  start() {}
  async stop() {}
  async tick() {}
}
