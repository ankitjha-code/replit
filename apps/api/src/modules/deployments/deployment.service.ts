import { randomBytes } from 'node:crypto';
import {
  DEPLOYMENT_TRANSITIONS,
  canTransition,
  deploymentConfigProblem,
  readPackageJson,
  type DeploymentConfig,
  type DeploymentLogResponse,
  type DeploymentStateResponse,
  type DeploymentStatus,
  type DeploymentSummary,
  type ResourceLimits,
} from '@platform/shared';
import type { Logger } from 'pino';
import { AppError } from '../../errors/app-error.js';
import type { BuildHandle, DeploymentProvider } from '../../deploy/provider.js';
import type { ProjectEventPublisher } from '../../events/project-event-bus.js';
import type { StorageProvider } from '../../storage/provider.js';
import type { FileService } from '../files/file.service.js';
import type { SnapshotService } from '../snapshots/snapshot.service.js';
import { buildSnapshotArchive } from '../snapshots/snapshot-archive.js';
import { BuildLog } from './build-log.js';
import type { DeploymentRecord, DeploymentRepository } from './deployment.repository.js';

/**
 * What was stored for a deployment, if anything.
 *
 * Empty for a server, whose files never leave the workload they were built in.
 */
interface StoredArtifact {
  artifactKey?: string;
  artifactBytes?: number;
  fileCount?: number;
}

/**
 * The pieces of other services this one needs, named rather than imported.
 *
 * Structural types so this module does not depend on the variable, secret and
 * database services themselves: it needs one method from each, and the smaller
 * the surface the less there is to be wrong about.
 */
interface EnvironmentSource {
  forRuntime(projectId: string): Promise<Record<string, string>>;
}

interface RuntimeDetector {
  detect(projectId: string): Promise<{ image: string } | null>;
}

/**
 * Where a project is published, as this service needs it.
 *
 * Narrow on purpose: deploying needs an address and has nothing to say about
 * how addresses are chosen, verified or served.
 */
interface AddressSource {
  ensureSubdomain(projectId: string): Promise<string>;
  addressOf(projectId: string): Promise<{ subdomain: string; url: string } | null>;
  /**
   * Where one release answers, as opposed to where the project does.
   *
   * Built from the label and the installation's own domain rather than stored,
   * so a change of domain does not leave every past release advertising an
   * address that no longer resolves.
   */
  releaseAddress(label: string): string;
}

/** What the public listener needs in order to answer one request. */
export type ServingDeployment =
  | { kind: 'static'; artifactKey: string }
  | { kind: 'server'; target: { host: string; port: number } };

/**
 * Deployments: a project running somewhere that is not somebody's workspace.
 *
 * The difference from a runtime is not scale. A runtime exists because a
 * browser tab is open, is seeded from the files as they are this second, and is
 * unreachable from outside. A deployment is built from a fixed version, is
 * expected to outlive every session and every restart of this process, and is
 * meant to be reachable by people with no account here.
 *
 * **This installation cannot deploy anything.** The provider port has one
 * implementation and it refuses, which is the honest state of the work rather
 * than a placeholder: the model, the lifecycle, the record and the API exist,
 * and nothing builds an image or serves a request yet. What that means in
 * practice is that `create` refuses before writing anything, following the rule
 * the database and runtime services already set: an installation with no
 * backend must not accumulate rows describing things that will never exist.
 */

export interface DeploymentServiceOptions {
  /** Deployments one project may keep before the oldest finished ones go. */
  maxPerProject: number;
  /** What a deployment is allowed of the machine, separate from a runtime's. */
  limits: ResourceLimits;
  /** How much of a build's output is kept to show afterwards. */
  maxLogBytes: number;
}

export class DeploymentService {
  constructor(
    private readonly deployments: DeploymentRepository,
    private readonly files: FileService,
    private readonly snapshots: SnapshotService,
    private readonly storage: StorageProvider,
    private readonly provider: DeploymentProvider,
    private readonly runtimes: RuntimeDetector,
    private readonly addresses: AddressSource,
    private readonly variables: EnvironmentSource,
    private readonly secrets: EnvironmentSource,
    private readonly databases: EnvironmentSource,
    private readonly options: DeploymentServiceOptions,
    private readonly log: Logger,
  ) {}

  /**
   * Where deployment changes are announced, when there is anywhere to announce
   * them. Set after construction, as the file service's is.
   */
  private events: ProjectEventPublisher | undefined;

  useEvents(events: ProjectEventPublisher): void {
    this.events = events;
  }

  /**
   * The unpacked-site cache, when the public listener is running.
   *
   * Told when a deployment goes so it can drop what it is holding for it.
   * Optional and set after construction, because the cache belongs to the
   * listener and a control plane with no listener still has deployments.
   */
  private artifacts: { forget(storageKey: string): void } | undefined;

  useArtifacts(artifacts: { forget(storageKey: string): void }): void {
    this.artifacts = artifacts;
  }

  /**
   * Where a deployment's output is written down, when there is anywhere.
   *
   * Set after construction, as the file service's event publisher is: a
   * deployment service built for a unit test keeps no log.
   */
  private logs:
    | {
        record(input: {
          projectId: string;
          source: 'DEPLOYMENT';
          sourceId: string;
          stream: 'stdout' | 'stderr';
          chunk: string;
        }): void;
      }
    | undefined;

  useLogs(logs: NonNullable<typeof this.logs>): void {
    this.logs = logs;
  }

  /**
   * Where the slow half of deploying is put, when there is anywhere.
   *
   * A build installs dependencies, which routinely takes minutes. Holding the
   * request open for that was written down as a known problem the moment
   * deployments existed, in the same words the runtime's image pull was.
   *
   * Optional, so a control plane with no job table still deploys the old way, in
   * the request. Worse, and better than nothing.
   */
  private queue:
    | {
        enqueue(
          type: 'DEPLOYMENT_BUILD',
          payload: unknown,
          options: { projectId: string },
        ): Promise<unknown>;
      }
    | undefined;

  useJobQueue(queue: NonNullable<typeof this.queue>): void {
    this.queue = queue;
  }

  /**
   * How much of the platform the project's owner may be using at once.
   *
   * Optional and set after construction, as this service's other collaborators
   * are. Without one the host's own capacity is the only ceiling, which is the
   * behaviour this platform had before quotas existed.
   */
  private quotas:
    { require(projectId: string, kind: 'DEPLOYMENTS' | 'BUILDS'): Promise<void> } | undefined;

  useQuotas(quotas: NonNullable<typeof this.quotas>): void {
    this.quotas = quotas;
  }

  unavailableReason(): Promise<string | null> {
    return this.provider.unavailableReason();
  }

  /** Everything a project's deployment page needs, in one answer. */
  async describe(projectId: string): Promise<DeploymentStateResponse> {
    const [records, config, live, unavailableReason, suggestion] = await Promise.all([
      this.deployments.listForProject(projectId, this.options.maxPerProject),
      this.deployments.findConfig(projectId),
      this.deployments.findLive(projectId),
      this.unavailableReason(),
      this.suggest(projectId),
    ]);

    const address = await this.addresses.addressOf(projectId);

    return {
      deployments: records.map((record) => this.summarize(record)),
      subdomain: address?.subdomain ?? null,
      url: address?.url ?? null,
      config: config
        ? {
            target: config.target,
            buildCommand: config.buildCommand,
            outputDirectory: config.outputDirectory,
            startCommand: config.startCommand,
          }
        : null,
      suggestion,
      liveId: live?.id ?? null,
      unavailableReason,
      limit: this.options.maxPerProject,
    };
  }

  /**
   * Records how this project is built and started.
   *
   * Kept on the project rather than supplied per deployment, exactly as the run
   * command is: saying how to build something should not have to be repeated
   * every time it is built, and a request that could override it would mean two
   * answers to the same question and a history that describes neither.
   */
  async setConfig(projectId: string, config: DeploymentConfig): Promise<DeploymentStateResponse> {
    const problem = deploymentConfigProblem(config);
    if (problem) {
      // The same function the form runs before sending, so the two can never
      // drift into disagreeing about what is valid.
      throw new AppError('VALIDATION_FAILED', problem, { expose: true });
    }

    await this.deployments.setConfig(projectId, {
      target: config.target,
      buildCommand: config.buildCommand,
      outputDirectory: config.outputDirectory,
      startCommand: config.startCommand,
    });

    this.log.info({ projectId, target: config.target }, 'deployment configuration set');
    this.events?.publish(projectId, { type: 'deployments.changed' });

    return this.describe(projectId);
  }

  /**
   * What the platform would deploy this project as, and how.
   *
   * Read from the project's files, in the same spirit as runtime detection and
   * the run command suggestion: declarations before conventions, and nothing at
   * all rather than a guess when the project says neither. A suggestion nobody
   * can check is indistinguishable from an invention, and this one decides what
   * gets built.
   */
  async suggest(projectId: string): Promise<DeploymentConfig | null> {
    const tree = await this.files.listTree(projectId);
    const paths = tree.entries.filter((entry) => entry.type === 'FILE').map((entry) => entry.path);

    if (paths.length === 0) return null;

    const manifest = paths.includes('package.json')
      ? readPackageJson((await this.files.read(projectId, 'package.json')).content)
      : {};

    const scripts = manifest.packageScripts ?? {};

    /*
     * A build script and a known output directory means a static site.
     *
     * Checked before the server case because it is the more specific one: a
     * project with a build script and a start script is a server that also
     * builds, and a project with a build script and no start script is a site.
     */
    if (scripts.build) {
      const output = ['dist', 'build', 'out', 'public'].find((directory) =>
        paths.some((path) => path === directory || path.startsWith(`${directory}/`)),
      );

      if (!scripts.start && output) {
        return {
          target: 'STATIC',
          buildCommand: 'npm run build',
          outputDirectory: output,
          startCommand: null,
        };
      }
    }

    if (scripts.start) {
      return {
        target: 'SERVER',
        buildCommand: scripts.build ? 'npm run build' : null,
        outputDirectory: null,
        startCommand: 'npm start',
      };
    }

    // No manifest to read. A project that is only an index.html is a site, and
    // it is the one case that can be recognised from a filename alone.
    if (paths.includes('index.html')) {
      return { target: 'STATIC', buildCommand: null, outputDirectory: '.', startCommand: null };
    }

    /*
     * Everything else is left to a person.
     *
     * The runtime detector can say what language a project is written in, and
     * that is deliberately not used here: knowing a project is Python is not
     * knowing how it is built, and a start command derived from a filename
     * would be a guess about something that is about to be exposed to the
     * public. Nothing beats a wrong suggestion for that.
     */
    return null;
  }

  /**
   * Builds a project and publishes it.
   *
   * The whole path, in the order the lifecycle describes it:
   *
   *  1. Refuse before writing anything when there is no backend. A platform
   *     with nowhere to deploy must not fill a project's history with rows
   *     describing deployments that never happened.
   *  2. Freeze the version, as a snapshot, so what is running has an answer
   *     that survives the next keystroke.
   *  3. Build, in a container, with the project's own environment.
   *  4. For a static site, take the output away and store it; the workload is
   *     then thrown away and the platform serves the bytes itself.
   *     For a server, start the application in the same workload and wait for
   *     it to answer.
   *
   * The request is held open for all of it. That is honest and it is slow: a
   * build that installs dependencies takes minutes, and this is the wrong shape
   * for that. It is the same shape starting a runtime has, and it belongs on a
   * queue for the same reason.
   */
  async create(
    projectId: string,
    userId: string,
    input: { note?: string | undefined },
  ): Promise<DeploymentSummary> {
    const reason = await this.provider.unavailableReason();
    if (reason) throw new AppError('SERVICE_UNAVAILABLE', reason, { expose: true });

    const config = await this.deployments.findConfig(projectId);
    if (!config) {
      throw new AppError(
        'PRECONDITION_FAILED',
        'Say how this project is built and started before deploying it.',
      );
    }

    const detected = await this.runtimes.detect(projectId);
    if (!detected) {
      throw new AppError(
        'PRECONDITION_FAILED',
        'The platform cannot tell what this project is written in, so it cannot build it.',
      );
    }

    /*
     * Two ceilings, and they are genuinely different questions.
     *
     * How many deployments this account may have live at once, and how many
     * builds it may have running at once. A build is far the more expensive of
     * the two — a machine installing dependencies flat out, rather than a
     * container sitting there — so it is limited separately and more tightly.
     *
     * Both before anything is written, including before the snapshot: a refused
     * deployment must not leave a copy of a project's source behind.
     */
    await this.quotas?.require(projectId, 'DEPLOYMENTS');
    await this.quotas?.require(projectId, 'BUILDS');

    const note = input.note?.trim() ? input.note.trim() : null;

    /*
     * The address, assigned now if the project has none.
     *
     * On first deployment rather than at project creation: a name nobody is
     * using is a name taken from everybody else for nothing. Before anything is
     * built, so a build is never spent on something that then has nowhere to go.
     */
    await this.addresses.ensureSubdomain(projectId);
    const address = await this.addresses.addressOf(projectId);

    if (!address) {
      throw new AppError(
        'CONFLICT',
        'This project could not be given a deployment address. Choose one yourself and try again.',
      );
    }

    await this.prune(projectId);

    /*
     * The version being deployed, frozen before anything is built.
     *
     * This is what makes a deployment a release rather than a moment in an
     * editing session: an edit landing a second later changes the project and
     * not what is running. The snapshot is kept for as long as the deployment
     * is, so "what is actually live" has an answer that can be read and rebuilt.
     */
    const snapshot = await this.snapshots.captureForDeployment(
      projectId,
      userId,
      note ?? new Date().toISOString(),
    );

    const record = await this.deployments.create({
      projectId,
      target: config.target,
      note,
      buildCommand: config.buildCommand,
      outputDirectory: config.outputDirectory,
      startCommand: config.startCommand,
      snapshotId: snapshot.id,
      requestedById: userId,
      releaseLabel: await this.uniqueReleaseLabel(),
    });

    this.events?.publish(projectId, { type: 'deployments.changed' });

    /*
     * Recorded as requested, then handed to a worker.
     *
     * The row is REQUESTED at this point, which the page already knows how to
     * show, and it is polled: nothing about the browser changes except that it
     * stops waiting for a build to finish inside one request.
     *
     * With no queue configured the build happens here, exactly as it used to.
     */
    if (this.queue) {
      await this.queue.enqueue(
        'DEPLOYMENT_BUILD',
        { deploymentId: record.id, actorId: userId },
        { projectId },
      );
      return this.summarize(record);
    }

    return this.build(record.id, projectId, userId);
  }

  /**
   * Builds a deployment that has been requested, and publishes it.
   *
   * The half of `create` a worker does. Public because the worker is outside
   * this service and inside the platform; no route reaches it.
   *
   * Reloads the row and refuses anything that is not still REQUESTED. A job may
   * be picked up a minute after a restart, and in between the deployment may
   * have been cancelled, removed, or built by a duplicate.
   */
  async buildRequested(deploymentId: string, actorId: string): Promise<void> {
    const record = await this.deployments.findByIdAnywhere(deploymentId);

    if (!record) {
      this.log.info({ deploymentId }, 'a queued build had nothing to build');
      return;
    }

    if (record.status !== 'REQUESTED') {
      this.log.info(
        { deploymentId, status: record.status },
        'a queued build found the deployment already moved on',
      );
      return;
    }

    await this.build(deploymentId, record.projectId, actorId);
  }

  /**
   * Records that a requested deployment is never going to be built.
   *
   * Called when the work was given up on: its attempts ran out, or the worker
   * holding it died with none left. Without this the row sits in REQUESTED for
   * ever, looking like a build that is about to start.
   *
   * Only from REQUESTED, for the same reason the runtime's equivalent is: a
   * build that got as far as BUILDING recorded its own failure, with its log,
   * and replacing that with a vaguer reason would lose the useful half.
   */
  async abandonRequested(deploymentId: string, reason: string): Promise<void> {
    const record = await this.deployments.findByIdAnywhere(deploymentId);
    if (!record || record.status !== 'REQUESTED') return;

    await this.move(record, 'FAILED', record.requestedById ?? '', reason, {
      stoppedAt: new Date(),
    });

    this.log.warn(
      { deploymentId, projectId: record.projectId },
      'a requested deployment was abandoned',
    );
    this.events?.publish(record.projectId, { type: 'deployments.changed' });
  }

  /** Everything between REQUESTED and RUNNING. */
  private async build(
    deploymentId: string,
    projectId: string,
    userId: string,
  ): Promise<DeploymentSummary> {
    const record = await this.deployments.findById(projectId, deploymentId);
    if (!record) throw new AppError('NOT_FOUND', 'There is no deployment with that identifier');

    const config = await this.deployments.findConfig(projectId);
    if (!config) {
      throw new AppError(
        'PRECONDITION_FAILED',
        'Say how this project is built and started before deploying it.',
      );
    }

    const detected = await this.runtimes.detect(projectId);
    if (!detected) {
      throw new AppError(
        'PRECONDITION_FAILED',
        'The platform cannot tell what this project is written in, so it cannot build it.',
      );
    }

    const address = await this.addresses.addressOf(projectId);
    if (!address) {
      throw new AppError(
        'CONFLICT',
        'This project has no deployment address, so there is nowhere to publish it.',
      );
    }

    const snapshotId = record.snapshotId;
    if (!snapshotId) {
      throw new AppError(
        'PRECONDITION_FAILED',
        'The version this deployment was meant to be built from is no longer available.',
      );
    }

    const building = await this.move(record, 'BUILDING', userId, null);
    const log = new BuildLog(this.options.maxLogBytes);

    let workload: BuildHandle | undefined;

    try {
      /*
       * The snapshot's files, not the project's.
       *
       * Read back out of the archive that was just written rather than exported
       * again, so a build is provably of the version the deployment points at.
       * Exporting twice would leave a window in which an edit landed between
       * them and the deployment described a version it was not built from.
       */
      const entries = (await this.snapshots.readEntries(projectId, snapshotId)).entries;
      const environment = await this.environmentFor(projectId);

      workload = await this.provider.build({
        deploymentId: record.id,
        projectId,
        image: detected.image,
        entries,
        buildCommand: config.buildCommand,
        outputDirectory: config.outputDirectory,
        environment,
        limits: this.options.limits,
        onLog: (chunk) => log.write(chunk),
      });

      const published =
        config.target === 'STATIC'
          ? await this.publishStatic(record.id, projectId, workload, config.outputDirectory ?? '.')
          : await this.publishServer(
              building,
              userId,
              workload,
              config.startCommand ?? '',
              environment,
            );

      /*
       * A static site has no process to start, but it passes through STARTING
       * like every other release (a rollback does the same), because the
       * transition table only reaches RUNNING from there. Moving straight from
       * BUILDING was refused, so no static site could ever be deployed — found
       * by the first test that deployed one.
       */
      const ready =
        published.record.status === 'BUILDING'
          ? await this.move(published.record, 'STARTING', userId, null)
          : published.record;

      const running = await this.move(ready, 'RUNNING', userId, null, {
        startedAt: new Date(),
        /*
         * The address as it stands now, written onto the deployment.
         *
         * Copied rather than derived on read, for the reason every other copied
         * field here exists: an old deployment should say where it was
         * published, not where the project is published today. Changing a
         * project's address does not rewrite its history.
         */
        url: address.url,
      });

      await this.deployments.recordBuild(record.id, {
        log: log.text(),
        truncated: log.truncated,
        ...published.stored,
      });

      this.log.info({ projectId, deploymentId: record.id }, 'deployment running');

      if (config.target === 'SERVER') await this.stopSuperseded(projectId, record.id, userId);

      this.events?.publish(projectId, { type: 'deployments.changed' });

      return this.summarize((await this.deployments.findById(projectId, record.id)) ?? running);
    } catch (error) {
      const message =
        error instanceof AppError && error.expose
          ? error.message
          : 'This deployment could not be built.';

      this.log.error({ err: error, projectId, deploymentId: record.id }, 'deployment failed');

      /*
       * The workload goes, and the log stays.
       *
       * A failed build's container has nothing anybody can use: there is no
       * terminal into a deployment and no reason to keep one. What the build
       * printed is the entire value of a failure, so it is written down before
       * anything else is cleaned up.
       */
      await this.deployments
        .recordBuild(record.id, { log: log.text(), truncated: log.truncated })
        .catch(() => undefined);

      if (workload) await this.provider.destroy(workload).catch(() => undefined);

      await this.move(building, 'FAILED', userId, message, { stoppedAt: new Date() });
      this.events?.publish(projectId, { type: 'deployments.changed' });

      throw error instanceof AppError
        ? error
        : new AppError('EXECUTION_FAILED', message, { expose: true });
    }
  }

  /**
   * Stores a static build and lets its workload go.
   *
   * The bytes are written before the row points at them, following the rule
   * every store-then-record path here follows, and the workload is destroyed
   * afterwards: a static site needs nothing running, which is why it keeps
   * working while the container backend is down.
   */
  private async publishStatic(
    deploymentId: string,
    projectId: string,
    workload: BuildHandle,
    outputDirectory: string,
  ): Promise<{ record: DeploymentRecord; stored: StoredArtifact }> {
    const reason = await this.storage.unavailableReason();
    if (reason) throw new AppError('SERVICE_UNAVAILABLE', reason, { expose: true });

    const { files } = await this.provider.collect(workload, outputDirectory);

    if (files.length === 0) {
      throw new AppError(
        'PRECONDITION_FAILED',
        `The build left nothing in "${outputDirectory}", so there is nothing to publish.`,
      );
    }

    const { archive, fileCount } = await buildSnapshotArchive(
      files.map((file) => ({ path: file.path, content: file.content })),
    );

    const storageKey = `deployments/${projectId}/${deploymentId}.tar`;
    await this.storage.put(storageKey, archive, 'application/x-tar');

    // Nothing is left running for a static site, so the container goes as soon
    // as its output is safely elsewhere.
    await this.provider.destroy(workload).catch((error: unknown) => {
      this.log.error(
        { err: error, deploymentId },
        'a build workload could not be removed and is now orphaned',
      );
    });

    const record = await this.deployments.findById(projectId, deploymentId);
    if (!record) throw new AppError('NOT_FOUND', 'There is no deployment with that identifier');

    return {
      record,
      stored: { artifactKey: storageKey, artifactBytes: archive.byteLength, fileCount },
    };
  }

  /** Starts a server deployment in the workload it was built in. */
  private async publishServer(
    building: DeploymentRecord,
    userId: string,
    workload: BuildHandle,
    startCommand: string,
    environment: Record<string, string>,
  ): Promise<{ record: DeploymentRecord; stored: StoredArtifact }> {
    const starting = await this.move(building, 'STARTING', userId, null, {
      provider: this.provider.name,
      externalId: workload.externalId,
      // Written down beside the identifier that also encodes it, so the
      // scheduler can count what each machine is carrying without parsing one.
      executionHost: workload.host ?? null,
    });

    const handle = await this.provider.serve(workload, {
      deploymentId: building.id,
      startCommand,
      environment,

      // Written down, because this is the only chance: nothing reattaches to a
      // deployment after the request that started it, and there is no terminal
      // into one.
      onOutput: ({ stream, chunk }) => {
        this.logs?.record({
          projectId: building.projectId,
          source: 'DEPLOYMENT',
          sourceId: building.id,
          stream,
          chunk,
        });
      },

      onExit: (code) => {
        void this.recordExit(building.projectId, building.id, code);
      },
    });

    return {
      record: await this.moveContainerPort(starting, handle.containerPort),
      stored: {},
    };
  }

  /**
   * Records that a deployment's process ended.
   *
   * The only way the platform ever finds out, and only while the control plane
   * that started it is still running: nothing polls a deployment and nothing
   * reattaches after a restart. That limitation is real and is written down in
   * the architecture reference rather than hidden behind this method looking
   * thorough.
   *
   * Never throws. It runs from a stream handler with nobody to tell.
   */
  private async recordExit(
    projectId: string,
    deploymentId: string,
    code: number | null,
  ): Promise<void> {
    const message =
      code === null
        ? 'This deployment stopped and the platform could not learn why.'
        : `This deployment exited with code ${String(code)}.`;

    try {
      const record = await this.deployments.findById(projectId, deploymentId);

      /*
       * Somebody asked for it to stop, or it is being removed with its project:
       * that path records the stop itself. Checked before anything is written,
       * and read from the database rather than from memory, because the process
       * watching this exit is often not the one that asked — the worker runs
       * deployments, the API deletes projects.
       */
      if (!record || record.status !== 'RUNNING') return;

      this.logs?.record({
        projectId,
        source: 'DEPLOYMENT',
        sourceId: deploymentId,
        stream: 'stderr',
        chunk: `\n${message}\n`,
      });

      await this.move(record, 'FAILED', record.requestedById ?? '', message, {
        stoppedAt: new Date(),
      });

      this.log.warn({ projectId, deploymentId, code }, 'a running deployment exited');
      this.events?.publish(projectId, { type: 'deployments.changed' });
    } catch (error) {
      this.log.error({ err: error, projectId, deploymentId }, 'a deployment exit was not recorded');
    }
  }

  /**
   * What a deployed application is started with.
   *
   * The same three sources a development runtime gets, and deliberately so: a
   * deployed project that could not reach its own database would be a different
   * application from the one that was tested in the workspace. Platform
   * configuration and session keys are not among them and never reach here.
   */
  private async environmentFor(projectId: string): Promise<Record<string, string>> {
    const [database, variables, secrets] = await Promise.all([
      this.databases.forRuntime(projectId),
      this.variables.forRuntime(projectId),
      this.secrets.forRuntime(projectId),
    ]);
    return { ...database, ...variables, ...secrets };
  }

  /**
   * Stops one that is serving.
   *
   * The row stays. A deployment that was taken down is part of a project's
   * history and deleting it would answer "what was live last Tuesday" with
   * nothing.
   */
  async stop(projectId: string, deploymentId: string, userId: string): Promise<DeploymentSummary> {
    const record = await this.require(projectId, deploymentId);

    if (record.status === 'STOPPED' || record.status === 'FAILED') {
      // Asking twice for something to be stopped is not an error.
      return this.summarize(record);
    }

    const stopping = await this.move(record, 'STOPPING', userId, null);

    if (record.externalId) {
      try {
        await this.provider.stop({ externalId: record.externalId });
      } catch (error) {
        const message = 'This deployment could not be stopped.';
        this.log.error({ err: error, projectId, deploymentId }, message);
        await this.move(stopping, 'FAILED', userId, message, { stoppedAt: new Date() });
        throw new AppError('EXECUTION_FAILED', message, { expose: true });
      }
    }

    const stopped = await this.move(stopping, 'STOPPED', userId, null, { stoppedAt: new Date() });

    this.log.info({ projectId, deploymentId }, 'deployment stopped');
    this.events?.publish(projectId, { type: 'deployments.changed' });

    return this.summarize(stopped);
  }

  /**
   * Removes one from the history, and whatever the provider still holds for it.
   *
   * Refused while it is serving. Deleting the record of something that is still
   * up would leave the platform unable to say what is running or to take it
   * down, which is the one state a deployment record exists to prevent.
   */
  async remove(projectId: string, deploymentId: string): Promise<void> {
    const record = await this.require(projectId, deploymentId);

    if (record.status !== 'STOPPED' && record.status !== 'FAILED') {
      throw new AppError('PRECONDITION_FAILED', 'Stop this deployment before removing it.');
    }

    await this.release(record);
    await this.deployments.deleteById(projectId, deploymentId);

    this.log.info({ projectId, deploymentId }, 'deployment removed');
    this.events?.publish(projectId, { type: 'deployments.changed' });
  }

  /**
   * Removes everything a project has deployed, for when the project is going.
   *
   * Deliberately does not throw. A project must stay deletable when the backend
   * is unreachable, so a failure is logged as a leak rather than turned into a
   * project nobody can remove. The rows themselves cascade.
   */
  async releaseProject(projectId: string): Promise<void> {
    const records = await this.deployments.listForProject(projectId, Number.MAX_SAFE_INTEGER);
    for (const record of records) await this.release(record);
  }

  // -------------------------------------------------------------------------

  /**
   * Records the port a server deployment answered on, without moving it.
   *
   * Written through a transition because that is the only conditional write
   * this repository offers, and STARTING to STARTING is not a transition: the
   * port is recorded as part of arriving at STARTING rather than after it.
   */
  private async moveContainerPort(
    record: DeploymentRecord,
    containerPort: number,
  ): Promise<DeploymentRecord> {
    await this.deployments.recordPort(record.id, containerPort);
    return { ...record, containerPort };
  }

  /**
   * What is serving a project right now, for the public listener.
   *
   * Returns what it needs to answer a request and nothing else: a static site's
   * storage key, or a server's workload and port. Deliberately not a record,
   * because the listener is on a public port and the fewer of a deployment's
   * fields reach it the fewer can be leaked by a mistake there.
   */
  async serving(projectId: string): Promise<ServingDeployment | null> {
    return this.servingRecord(await this.deployments.findServing(projectId));
  }

  /**
   * What one particular release is serving, by its own address.
   *
   * Only while it is running. A release that has stopped keeps its label — the
   * history should be able to say what its address was — and the address stops
   * answering, which is the truth about it.
   *
   * The project is not checked here and does not need to be: the label is unique
   * across the installation and random, so it names exactly one release and
   * cannot be constructed from knowing another.
   */
  async servingRelease(label: string): Promise<ServingDeployment | null> {
    return this.servingRecord(await this.deployments.findByReleaseLabel(label));
  }

  private async servingRecord(record: DeploymentRecord | null): Promise<ServingDeployment | null> {
    if (!record) return null;

    if (record.target === 'STATIC') {
      return record.artifactKey ? { kind: 'static', artifactKey: record.artifactKey } : null;
    }

    if (!record.externalId || record.containerPort === null) return null;

    const target = await this.provider.target({
      externalId: record.externalId,
      containerPort: record.containerPort,
    });

    return target ? { kind: 'server', target } : null;
  }

  /** What a build printed, for somebody looking at why it went wrong. */
  async buildLog(projectId: string, deploymentId: string): Promise<DeploymentLogResponse> {
    const record = await this.require(projectId, deploymentId);
    return { log: record.buildLog ?? '', truncated: record.buildLogTruncated };
  }

  /**
   * Makes an earlier release live again.
   *
   * A **new** release pointing at old code, never a resurrection of an old row.
   * History stays a list of what happened, and going back is one of the things
   * that happened — which also means the release that was live keeps its own
   * record of having been live, rather than being quietly overwritten.
   *
   * ## What it costs depends on what was deployed
   *
   * - **A static site does not rebuild.** Its output is an archive in object
   *   storage. Going back copies that archive to the new release's own key and
   *   publishes it, which is seconds and cannot fail for any reason the original
   *   build did not already survive.
   * - **A server rebuilds from the same frozen source.** There is no image
   *   registry here: a server is built and run in one container, deliberately,
   *   because moving an installed dependency tree between containers would mean
   *   carrying it through the control plane. So what is kept is the exact code,
   *   and going back means building it again. The result is the same release;
   *   the wait is not, and the page says so rather than implying an instant
   *   rollback that would sometimes take four minutes.
   *
   * The copy is deliberate rather than sharing the old key. Two rows naming one
   * object would mean deleting either release deletes what the other serves, and
   * pruning removes old releases on its own.
   */
  async rollback(
    projectId: string,
    deploymentId: string,
    userId: string,
    input: { note?: string | undefined },
  ): Promise<DeploymentSummary> {
    const target = await this.require(projectId, deploymentId);

    /*
     * Only a release that actually worked.
     *
     * A static one is identified by having an artifact and a server one by
     * having been built at all; either way, a release that never produced
     * anything is not somewhere to go back to, and saying so plainly is better
     * than a rollback that fails in a build four minutes later.
     */
    if (target.target === 'STATIC' ? !target.artifactKey : !target.snapshotId) {
      throw new AppError(
        'PRECONDITION_FAILED',
        'That release never finished building, so there is nothing to go back to.',
        { expose: true },
      );
    }

    /*
     * "Already live" means it is the release the project's address serves — not
     * merely RUNNING. A superseded static release stays RUNNING on purpose, so
     * its own release address keeps working, and going back to it is exactly
     * what rollback is for. Checking the status refused every static rollback.
     */
    const live = await this.deployments.findServing(projectId);
    if (live?.id === target.id) {
      throw new AppError('PRECONDITION_FAILED', 'That release is already live.', { expose: true });
    }

    const reason = await this.provider.unavailableReason();
    if (reason) throw new AppError('SERVICE_UNAVAILABLE', reason, { expose: true });

    await this.quotas?.require(projectId, 'DEPLOYMENTS');

    const note = input.note?.trim()
      ? input.note.trim()
      : `Rolled back to ${target.note ?? target.createdAt.toISOString()}`;

    /*
     * The address is ensured again, cheaply.
     *
     * A project being rolled back has deployed before and so already has one.
     * Asking is one query and removes the case where it somehow does not.
     */
    await this.addresses.ensureSubdomain(projectId);

    await this.prune(projectId);

    const record = await this.deployments.create({
      projectId,
      target: target.target,
      note,
      buildCommand: target.buildCommand,
      outputDirectory: target.outputDirectory,
      startCommand: target.startCommand,
      // The same frozen source, deliberately shared rather than re-captured:
      // going back to a release means going back to its code, and capturing the
      // workspace now would capture whatever is in the editor instead.
      snapshotId: target.snapshotId,
      requestedById: userId,
      releaseLabel: await this.uniqueReleaseLabel(),
      rolledBackFromId: target.id,
    });

    this.events?.publish(projectId, { type: 'deployments.changed' });

    if (target.target === 'STATIC') return this.republishStatic(record, target, userId);

    // A server has to be built again; that is the whole of the asymmetry, and
    // from here it is an ordinary build of an ordinary release.
    if (this.queue) {
      await this.queue.enqueue(
        'DEPLOYMENT_BUILD',
        { deploymentId: record.id, actorId: userId },
        { projectId },
      );
      return this.summarize(record);
    }

    return this.build(record.id, projectId, userId);
  }

  /**
   * Publishes a static release from an archive that already exists.
   *
   * The build states are walked rather than skipped — REQUESTED, BUILDING,
   * STARTING, RUNNING — because the history of a release is read from those
   * events, and a release that appeared already running would be the one entry
   * in the list with no story.
   */
  private async republishStatic(
    record: DeploymentRecord,
    source: DeploymentRecord,
    userId: string,
  ): Promise<DeploymentSummary> {
    const artifactKey = source.artifactKey;
    if (!artifactKey) {
      throw new AppError('PRECONDITION_FAILED', 'That release has no stored output.');
    }

    const building = await this.move(record, 'BUILDING', userId, null);

    try {
      const reason = await this.storage.unavailableReason();
      if (reason) throw new AppError('SERVICE_UNAVAILABLE', reason, { expose: true });

      /*
       * Copied through here rather than asked of the store.
       *
       * Object stores can copy server-side, and this one is behind a port that
       * does not offer it. Adding a copy to the port for one caller would widen
       * an interface every implementation has to satisfy; a static site's output
       * is bounded by what a build produced, and this is the same read the
       * deployment server already does to serve it.
       */
      const stream = await this.storage.get(artifactKey);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
      const archive = Buffer.concat(chunks);
      const key = `deployments/${record.projectId}/${record.id}.tar`;
      await this.storage.put(key, archive, 'application/x-tar');

      await this.deployments.recordBuild(record.id, {
        artifactKey: key,
        artifactBytes: archive.byteLength,
        ...(source.fileCount === null ? {} : { fileCount: source.fileCount }),
      });

      const starting = await this.move(building, 'STARTING', userId, null);
      const address = await this.addresses.addressOf(record.projectId);

      const running = await this.move(starting, 'RUNNING', userId, null, {
        url: address?.url ?? null,
        startedAt: new Date(),
      });

      this.events?.publish(record.projectId, { type: 'deployments.changed' });

      return this.summarize(
        (await this.deployments.findById(record.projectId, record.id)) ?? running,
      );
    } catch (error) {
      const message =
        error instanceof AppError && error.expose
          ? error.message
          : 'That release could not be published again.';

      await this.move(building, 'FAILED', userId, message, { stoppedAt: new Date() });
      this.events?.publish(record.projectId, { type: 'deployments.changed' });
      throw error;
    }
  }

  /**
   * A label no other release is using.
   *
   * Random rather than derived from the identifier: those are time-ordered, so
   * a label derived from one would let anybody who has seen a release address
   * guess its neighbours — and a release address is a working URL.
   *
   * Collisions are checked rather than assumed away. At this size they are
   * vanishingly unlikely, and "vanishingly unlikely" is not the same as "the
   * unique index will not reject an insert one day".
   */
  private async uniqueReleaseLabel(): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const label = randomReleaseLabel();
      if (!(await this.deployments.releaseLabelExists(label))) return label;
    }

    throw new AppError('CONFLICT', 'A release address could not be assigned. Try again.');
  }

  /** Whether a label names a release here. For the certificate decision. */
  releaseExists(label: string): Promise<boolean> {
    return this.deployments.releaseLabelExists(label);
  }

  /**
   * A record as the browser reads it, with its release address filled in.
   *
   * The address is computed here rather than stored, and only while the release
   * is running: the label survives so history can show what the address was, and
   * a stopped release has nothing behind that address to answer.
   */
  private summarize(record: DeploymentRecord): DeploymentSummary {
    return toSummary(
      record,
      record.releaseLabel && record.status === 'RUNNING'
        ? this.addresses.releaseAddress(record.releaseLabel)
        : null,
    );
  }

  private async require(projectId: string, deploymentId: string): Promise<DeploymentRecord> {
    const record = await this.deployments.findById(projectId, deploymentId);
    if (!record) throw new AppError('NOT_FOUND', 'There is no deployment with that identifier');
    return record;
  }

  /**
   * Lets go of everything a deployment holds, without ever failing the caller.
   *
   * Two places: a workload in the execution plane, and an archive in object
   * storage. Neither failure is fatal here, because this runs while a project or
   * a deployment is being removed and refusing to remove it would be worse than
   * leaking. Both are logged as leaks, which is what the platform already does
   * for a database it could not drop.
   */
  private async release(record: DeploymentRecord): Promise<void> {
    if (record.externalId) {
      /*
       * Marked stopping before the container goes, so that whichever process
       * sees it exit reads a deliberate stop, not a crash. Without this, deleting
       * a project with a live deployment recorded the deployment as FAILED,
       * warned an operator, and tried to log against a project being deleted.
       */
      if (record.status === 'RUNNING') {
        await this.move(record, 'STOPPING', record.requestedById ?? '', null).catch(
          () => undefined,
        );
      }
      await this.provider.destroy({ externalId: record.externalId }).catch((error: unknown) => {
        this.log.error(
          { err: error, projectId: record.projectId, deploymentId: record.id },
          'a deployment could not be removed from its provider and is now orphaned',
        );
      });
    }

    if (record.artifactKey) {
      this.artifacts?.forget(record.artifactKey);

      await this.storage.delete(record.artifactKey).catch((error: unknown) => {
        this.log.error(
          { err: error, projectId: record.projectId, storageKey: record.artifactKey },
          'a deployment artifact could not be removed and is now orphaned',
        );
      });
    }
  }

  /**
   * Moves a deployment to a new status, refusing an illegal move.
   *
   * The transition table lives in shared code and is the same one the client
   * reads, so a move that is legal here cannot be illegal there. A lost race is
   * a conflict rather than a crash: two requests moving one deployment is
   * ordinary, and only one of them can be right.
   */
  private async move(
    record: DeploymentRecord,
    to: DeploymentStatus,
    actorId: string,
    message: string | null,
    extra: {
      provider?: string | null;
      externalId?: string | null;
      executionHost?: string | null;
      url?: string | null;
      startedAt?: Date;
      stoppedAt?: Date;
    } = {},
  ): Promise<DeploymentRecord> {
    if (!canTransition(DEPLOYMENT_TRANSITIONS, record.status, to)) {
      throw new Error(`Illegal deployment transition ${record.status} -> ${to}`);
    }

    const next = await this.deployments.transition({
      deploymentId: record.id,
      from: record.status,
      expectedRevision: record.revision,
      to,
      actorId,
      message,
      ...extra,
    });

    if (!next) {
      throw new AppError(
        'CONFLICT',
        'Someone else changed this deployment at the same time. Check its state and try again.',
      );
    }

    return next;
  }

  /**
   * Makes room before recording another one.
   *
   * Only stopped and failed deployments are candidates. Something serving is
   * never pruned however old it is: age is not a reason to take a site down.
   */
  /**
   * Stops the server releases a new one has replaced.
   *
   * A static release costs nothing once published, so an old one keeps serving
   * its own release address. A server release is a running container: left
   * alone, every deploy would add one, each holding its CPU and memory, and
   * after a handful the account's limit on live deployments refused all
   * further deploys of the very project being updated. Found by the first test
   * that deployed one project repeatedly. Going back is still possible: a server
   * rollback rebuilds from the release's frozen source.
   */
  /**
   * Stops every running server deployment that has written more than it may.
   * The same reasoning as for environments; a static site writes nothing.
   */
  async enforceDiskLimit(limitBytes: number): Promise<{ checked: number; stopped: number }> {
    let checked = 0;
    let stopped = 0;
    for (const release of await this.deployments.listRunningServers()) {
      if (!release.externalId) continue;
      const used = await this.provider.diskUsage({ externalId: release.externalId });
      checked += 1;
      if (used === null || used <= limitBytes) continue;

      this.log.warn(
        { projectId: release.projectId, deploymentId: release.id, used, limitBytes },
        'a deployment went over its disk limit and was stopped',
      );
      this.logs?.record({
        projectId: release.projectId,
        source: 'DEPLOYMENT',
        sourceId: release.id,
        stream: 'stderr',
        chunk: `\nStopped: this deployment wrote ${String(Math.round(used / 1048576))} MB to disk, over its ${String(Math.round(limitBytes / 1048576))} MB limit.\n`,
      });
      try {
        await this.stop(release.projectId, release.id, release.requestedById ?? '');
        stopped += 1;
      } catch (error) {
        this.log.error(
          { err: error, deploymentId: release.id },
          'a deployment over its disk limit could not be stopped',
        );
      }
    }
    return { checked, stopped };
  }

  private async stopSuperseded(projectId: string, liveId: string, userId: string): Promise<void> {
    const releases = await this.deployments.listForProject(projectId, this.options.maxPerProject);
    for (const release of releases) {
      if (release.id === liveId || release.target !== 'SERVER' || release.status !== 'RUNNING') {
        continue;
      }
      await this.stop(projectId, release.id, userId).catch((error: unknown) => {
        this.log.error(
          { err: error, projectId, deploymentId: release.id },
          'a superseded server release could not be stopped',
        );
      });
    }
  }

  private async prune(projectId: string): Promise<void> {
    const held = await this.deployments.countForProject(projectId);
    const excess = held - (this.options.maxPerProject - 1);
    if (excess <= 0) return;

    for (const record of await this.deployments.listPrunable(projectId, excess)) {
      await this.release(record);
      await this.deployments.deleteById(projectId, record.id);
    }
  }
}

function toSummary(record: DeploymentRecord, releaseUrl: string | null): DeploymentSummary {
  return {
    id: record.id,
    status: record.status,
    target: record.target,
    note: record.note,
    buildCommand: record.buildCommand,
    outputDirectory: record.outputDirectory,
    startCommand: record.startCommand,
    snapshotId: record.snapshotId,
    url: record.url,
    message: record.message,
    fileCount: record.fileCount,
    artifactBytes: record.artifactBytes,
    hasLog: (record.buildLog ?? '').length > 0,
    requestedBy: record.requestedBy?.username ?? null,
    createdAt: record.createdAt.toISOString(),
    statusChangedAt: record.statusChangedAt.toISOString(),
    startedAt: record.startedAt?.toISOString() ?? null,
    stoppedAt: record.stoppedAt?.toISOString() ?? null,
    /*
     * Built from the label rather than stored.
     *
     * A URL is a label plus a domain, and the domain is configuration. Storing
     * the whole thing would mean every release made before an installation
     * changed its domain kept advertising an address that no longer resolves.
     */
    releaseUrl,
    rolledBackFromId: record.rolledBackFromId,
  };
}

/**
 * A short, readable, unguessable label for one release.
 *
 * Base32 without the letters and digits that are read for one another — no
 * `i`, `l`, `o`, `0` or `1` — because this ends up in a URL somebody reads off
 * a screen and types somewhere else. Ten characters of it is about fifty bits,
 * which is far more than enough to make guessing a neighbour's release address
 * pointless.
 */
const LABEL_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const LABEL_LENGTH = 10;

function randomReleaseLabel(): string {
  const bytes = randomBytes(LABEL_LENGTH);
  let label = '';

  for (const byte of bytes) {
    // Modulo bias is irrelevant here: the alphabet is 31 long against 256, and
    // what this needs is unguessability rather than a uniform distribution.
    label += LABEL_ALPHABET[byte % LABEL_ALPHABET.length];
  }

  return label;
}
