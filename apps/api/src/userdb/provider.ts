export interface UserDatabaseSpec {
  name: string;
  role: string;
  password: string;
}

export interface UserDatabaseProvider {
  readonly name: string;

  unavailableReason(): Promise<string | null>;

  provision(spec: UserDatabaseSpec): Promise<void>;

  setPassword(role: string, password: string): Promise<void>;

  drop(spec: { name: string; role: string }): Promise<void>;

  reset(spec: { name: string; role: string }): Promise<void>;

  sizeOf(name: string): Promise<number | null>;

  list(): Promise<UserDatabaseSummary[]>;
}

export interface UserDatabaseSummary {
  name: string;
  role: string | null;
}
