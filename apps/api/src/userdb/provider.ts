/**
 * The boundary between the platform and wherever a project's own database is.
 *
 * The same shape as the execution and storage ports, for the same reason: the
 * platform decides what should exist and something else holds it. An
 * installation with no database server configured refuses honestly rather than
 * recording a row describing a database nobody ever made.
 *
 * ## Rules any implementation must keep
 *
 * 1. **Identifiers are the platform's, not a caller's.** A name arriving here
 *    is derived from a project identifier and validated before use. Nothing
 *    here may ever interpolate text a person typed into a statement.
 * 2. **Provisioning is all or nothing as far as the caller can tell.** A half
 *    made database, with a role and no database or the reverse, must not be
 *    reported as ready.
 * 3. **Dropping something absent succeeds.** Cleaning up after a failed
 *    provision, and deleting a project whose database never worked, both
 *    depend on it.
 * 4. **A reset leaves the same database reachable by the same credential.**
 *    Emptying a database must not be a way of quietly replacing it, or every
 *    connection string a person has written down stops working.
 * 4. **One project's role may not reach another project's database, and no
 *    role here may reach the platform's own.** The second half is guaranteed by
 *    this being a different server; the first has to be arranged.
 */

export interface UserDatabaseSpec {
  /** Physical database name. Platform-generated. */
  name: string;
  /** Role that owns it, and the only one allowed to connect. */
  role: string;
  password: string;
}

export interface UserDatabaseProvider {
  /** Recorded nowhere, but useful in a health probe and in logs. */
  readonly name: string;

  /**
   * Why a database cannot be provisioned, or null when one can.
   *
   * Asked before anything is written, so an installation with no server
   * refuses rather than leaving rows describing databases that do not exist.
   */
  unavailableReason(): Promise<string | null>;

  /** Creates the role and the database, and shuts everyone else out of it. */
  provision(spec: UserDatabaseSpec): Promise<void>;

  /** Replaces the role's password. Succeeds only if the role exists. */
  setPassword(role: string, password: string): Promise<void>;

  /** Removes the database and its role. Succeeds when they are already gone. */
  drop(spec: { name: string; role: string }): Promise<void>;

  /**
   * Empties the database, keeping its name, its owner and its password.
   *
   * Every connection string already written down keeps working, which is the
   * difference between resetting a database and replacing one.
   */
  reset(spec: { name: string; role: string }): Promise<void>;

  /**
   * How much room the database is taking, in bytes.
   *
   * Null when the answer cannot be had. A size nobody could measure is not
   * reported as zero, which would read as an empty database rather than as an
   * unanswered question.
   */
  sizeOf(name: string): Promise<number | null>;

  /**
   * The databases on the server that this platform made.
   *
   * For cleanup, which has no other way to find a database whose project is
   * gone: the platform's record of it was the row, and the row is what went
   * missing. Deleting a project already drops its database, and a drop that
   * failed because the server was unreachable is logged rather than blocking
   * the deletion — which is exactly the case this leaves behind.
   *
   * **Only databases matching the platform's own naming.** A server may hold
   * databases nobody here created, and an implementation that listed them would
   * be handing a cleanup routine a list of things it must never touch.
   */
  list(): Promise<UserDatabaseSummary[]>;
}

/** One database on the server, as cleanup needs to see it. */
export interface UserDatabaseSummary {
  name: string;
  /** Its owner, which is the role that would have to go with it. */
  role: string | null;
}
