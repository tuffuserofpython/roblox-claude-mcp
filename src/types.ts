// Shared types for the Roblox <-> Claude MCP bridge.

/** Categories of events the Roblox script reports. Keep in sync with the Lua side. */
export type EventType =
  | "movement"
  | "jump"
  | "click"
  | "tool"
  | "gui"
  | "remote"
  | "character"
  | "object"
  | "workspace"
  | "log" // print/warn/error output from any script (LogService)
  | "error" // unhandled runtime errors with traceback (ScriptContext)
  | "chat" // player chat messages
  | "custom"
  | "system"; // session lifecycle, errors, heartbeats

/** A single event emitted from the running Roblox game. */
export interface GameEvent {
  /** Monotonic sequence id assigned by the bridge on ingest. */
  seq: number;
  /** Event category. */
  type: EventType;
  /** Specific action within the category, e.g. "Jumping", "MouseClick". */
  action: string;
  /** Server time (os.clock based) when the Roblox side captured the event. */
  gameTime: number;
  /** Wall-clock ms when the bridge ingested the event. */
  ingestedAt: number;
  /** Player userId associated with the event, if any. */
  userId?: number;
  /** Player name associated with the event, if any. */
  playerName?: string;
  /** Arbitrary structured payload. */
  data?: Record<string, unknown>;
}

/** A command queued for the Roblox game to execute. */
export interface Command {
  id: string;
  /** Command kind understood by the Lua dispatcher. */
  kind: CommandKind;
  /** Command arguments. */
  args?: Record<string, unknown>;
  /** Wall-clock ms when queued. */
  queuedAt: number;
}

export type CommandKind =
  | "run_luau" // execute a Luau snippet on the server
  | "set_property" // set a property on an instance by path
  | "fire_remote" // fire a RemoteEvent
  | "create_instance" // create an instance under a parent path
  | "destroy_instance" // destroy an instance by path
  | "message" // send a notification to players
  | "snapshot"; // force an immediate state snapshot push

/** Result returned by the Roblox game for a previously dispatched command. */
export interface CommandResult {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  finishedAt: number;
}

/** Live snapshot of the game state, refreshed by the Roblox script. */
export interface GameState {
  updatedAt: number;
  gameTime: number;
  placeId?: number;
  jobId?: string;
  /** Where the bridge runs: "executor", "server", or "client". */
  context?: string;
  /** Identity of the user running the bridge (present under an executor). */
  executor?: { userId: number; name: string; displayName?: string } | null;
  players: PlayerState[];
  /** Free-form counts/metrics the script chooses to expose. */
  metrics?: Record<string, unknown>;
  /** Optional shallow tree of selected instances. */
  tree?: unknown;
}

export interface PlayerState {
  userId: number;
  name: string;
  displayName?: string;
  position?: [number, number, number];
  velocity?: [number, number, number];
  health?: number;
  maxHealth?: number;
  humanoidState?: string;
  walkSpeed?: number;
  equippedTool?: string;
  ping?: number;
}
