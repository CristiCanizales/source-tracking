/*
 * Copyright (c) 2021, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import * as path from 'path';
import { NamedPackageDir, Logger, Org, SfdxProject } from '@salesforce/core';
import { ComponentSet, MetadataResolver, SourceComponent } from '@salesforce/source-deploy-retrieve';

import { RemoteSourceTrackingService, RemoteChangeElement, getMetadataKey } from './shared/remoteSourceTrackingService';
import { ShadowRepo } from './shared/localShadowRepo';
import { RemoteSyncInput } from './shared/types';

export const getKeyFromObject = (element: RemoteChangeElement | ChangeResult): string => {
  if (element.type && element.name) {
    return getMetadataKey(element.type, element.name);
  }
  throw new Error(`unable to complete key from ${JSON.stringify(element)}`);
};

// external users of SDR might need to convert a fileResponse to a key
export const getKeyFromStrings = getMetadataKey;

export interface ChangeOptions {
  origin?: 'local' | 'remote';
  state: 'add' | 'delete' | 'changed' | 'unchanged' | 'moved';
}

export interface LocalUpdateOptions {
  files?: string[];
  deletedFiles?: string[];
}

/**
 * Summary type that supports both local and remote change types
 */
export type ChangeResult = Partial<RemoteChangeElement> & {
  origin: 'local' | 'remote';
  filenames?: string[];
};

export interface ConflictError {
  message: string;
  name: 'conflict';
  conflicts: ChangeResult[];
}
export class SourceTracking {
  private orgId: string;
  private projectPath: string;
  private packagesDirs: NamedPackageDir[];
  private username: string;
  private logger: Logger;

  // remote and local tracking may not exist if not initialized
  private localRepo!: ShadowRepo;
  private remoteSourceTrackingService!: RemoteSourceTrackingService;

  public constructor(options: { org: Org; project: SfdxProject }) {
    this.orgId = options.org.getOrgId();
    this.username = options.org.getUsername() as string;
    this.projectPath = options.project.getPath();
    this.packagesDirs = options.project.getPackageDirectories();
    this.logger = Logger.childFromRoot('SourceTracking');
  }

  // public async deployLocalChanges({ overwrite = false, ignoreWarnings = false, wait = 33 }): Promise<void> {
  //   // TODO: this is basically the logic for a push
  // }

  // public async retrieveRemoteChanges(): Promise<void> {
  //   // TODO: this is basically the logic for a pull
  // }

  /**
   * Get metadata changes made locally and in the org.
   *
   * @returns local and remote changed metadata
   */
  public async getChanges(options?: ChangeOptions): Promise<ChangeResult[]> {
    if (options?.origin === 'local') {
      await this.ensureLocalTracking();
      if (options.state === 'changed') {
        return (await this.localRepo.getModifyFilenames()).map((filename) => ({
          filenames: [filename],
          origin: 'local',
        }));
      }
      if (options.state === 'delete') {
        return (await this.localRepo.getDeleteFilenames()).map((filename) => ({
          filenames: [filename],
          origin: 'local',
        }));
      }
      if (options.state === 'add') {
        return (await this.localRepo.getAddFilenames()).map((filename) => ({
          filenames: [filename],
          origin: 'local',
        }));
      }
    }
    if (options?.origin === 'remote') {
      await this.ensureRemoteTracking();
      const remoteChanges = await this.remoteSourceTrackingService.retrieveUpdates();
      this.logger.debug('remoteChanges', remoteChanges);
      return remoteChanges
        .filter((change) => change.deleted === (options.state === 'delete'))
        .map((change) => ({ ...change, origin: 'remote' }));
    }

    // by default return all local and remote changes
    // eslint-disable-next-line no-console
    this.logger.debug(options);
    return [];
  }

  public async getRemoteChanges(): Promise<RemoteChangeElement[]> {
    await this.ensureRemoteTracking();
    return this.remoteSourceTrackingService.retrieveUpdates();
  }
  /**
   * Update tracking for the options passed.
   *
   * @param options the files to update
   */
  public async updateLocalTracking(options: LocalUpdateOptions): Promise<void> {
    await this.ensureLocalTracking();
    await this.localRepo.commitChanges({
      deployedFiles: options.files?.map((file) => this.ensureRelative(file)),
      deletedFiles: options.deletedFiles?.map((file) => this.ensureRelative(file)),
    });
  }

  /**
   * Mark remote source tracking files that we have received to the latest version
   */
  public async updateRemoteTracking(fileResponses: RemoteSyncInput[]): Promise<void> {
    await this.ensureRemoteTracking();
    // TODO: poll for source tracking to be complete
    // to make sure we have the updates before syncing the ones from metadataKeys
    await this.remoteSourceTrackingService.retrieveUpdates({ cache: false });
    await this.remoteSourceTrackingService.syncSpecifiedElements(fileResponses);
  }

  /**
   * If the local tracking shadowRepo doesn't exist, it will be created.
   * Does nothing if it already exists.
   * Useful before parallel operations
   */
  public async ensureLocalTracking(): Promise<void> {
    if (this.localRepo) {
      return;
    }
    this.localRepo = await ShadowRepo.create({
      orgId: this.orgId,
      projectPath: this.projectPath,
      packageDirs: this.packagesDirs,
    });
    // loads the status from file so that it's cached
    await this.localRepo.getStatus();
  }

  /**
   * If the remote tracking shadowRepo doesn't exist, it will be created.
   * Does nothing if it already exists.
   * Useful before parallel operations
   */
  public async ensureRemoteTracking(initializeWithQuery = false): Promise<void> {
    if (this.remoteSourceTrackingService) {
      this.logger.debug('ensureRemoteTracking: remote tracking already exists');
      return;
    }
    this.logger.debug('ensureRemoteTracking: remote tracking does not exist yet; getting instance');
    this.remoteSourceTrackingService = await RemoteSourceTrackingService.getInstance({
      username: this.username,
      orgId: this.orgId,
    });
    if (initializeWithQuery) {
      await this.remoteSourceTrackingService.retrieveUpdates();
    }
  }

  /**
   * Deletes the local tracking shadowRepo
   * return the list of files that were in it
   */
  public async clearLocalTracking(): Promise<string> {
    await this.ensureLocalTracking();
    return this.localRepo.delete();
  }

  /**
   * Commits all the local changes so that no changes are present in status
   */
  public async resetLocalTracking(): Promise<string[]> {
    await this.ensureLocalTracking();
    const [deletes, nonDeletes] = await Promise.all([
      this.localRepo.getDeleteFilenames(),
      this.localRepo.getNonDeleteFilenames(),
    ]);
    await this.localRepo.commitChanges({
      deletedFiles: deletes,
      deployedFiles: nonDeletes,
      message: 'via resetLocalTracking',
    });
    return [...deletes, ...nonDeletes];
  }

  /**
   * Deletes the remote tracking files
   */
  public async clearRemoteTracking(): Promise<string> {
    return RemoteSourceTrackingService.delete(this.orgId);
  }

  /**
   * Sets the files to max revision so that no changes appear
   */
  public async resetRemoteTracking(serverRevision?: number): Promise<number> {
    await this.ensureRemoteTracking();
    const resetMembers = await this.remoteSourceTrackingService.reset(serverRevision);
    return resetMembers.length;
  }

  /**
   * uses SDR to translate remote metadata records into local file paths
   */
  // public async populateFilePaths(elements: ChangeResult[]): Promise<ChangeResult[]> {
  public populateFilePaths(elements: ChangeResult[]): ChangeResult[] {
    if (elements.length === 0) {
      return [];
    }

    this.logger.debug('populateFilePaths for change elements', elements);
    // component set generated from an array of ComponentLike from all the remote changes
    const remoteChangesAsComponentLike = elements.map((element) => ({
      type: element?.type as string,
      fullName: element?.name as string,
    }));
    const remoteChangesAsComponentSet = new ComponentSet(remoteChangesAsComponentLike);

    this.logger.debug(` the generated component set has ${remoteChangesAsComponentSet.size.toString()} items`);
    if (remoteChangesAsComponentSet.size < elements.length) {
      throw new Error(
        `unable to generate complete component set for ${elements
          .map((element) => `${element.name}(${element.type})`)
          .join(',')}`
      );
    }

    const matchingLocalSourceComponentsSet = ComponentSet.fromSource({
      fsPaths: this.packagesDirs.map((dir) => dir.path),
      include: remoteChangesAsComponentSet,
    });
    this.logger.debug(
      ` local source-backed component set has ${matchingLocalSourceComponentsSet.size.toString()} items from remote`
    );

    // make it simpler to find things later
    const elementMap = new Map<string, ChangeResult>();
    elements.map((element) => {
      elementMap.set(getKeyFromObject(element), element);
    });

    // iterates the local components and sets their filenames
    for (const matchingComponent of matchingLocalSourceComponentsSet.getSourceComponents().toArray()) {
      if (matchingComponent.fullName && matchingComponent.type.name) {
        this.logger.debug(
          `${matchingComponent.fullName}|${matchingComponent.type.name} matches ${
            matchingComponent.xml
          } and maybe ${matchingComponent.walkContent().toString()}`
        );
        const key = getKeyFromStrings(matchingComponent.type.name, matchingComponent.fullName);
        elementMap.set(key, {
          ...(elementMap.get(key) as ChangeResult),
          modified: true,
          filenames: [matchingComponent.xml as string, ...matchingComponent.walkContent()].filter(
            (filename) => filename
          ),
        });
      }
    }

    return Array.from(elementMap.values());
  }

  /**
   * uses SDR to translate remote metadata records into local file paths (which only typically have the filename).
   *
   * @input elements: ChangeResult[]
   * @input excludeUnresolvables: boolean Filter out components where you can't get the name and type (that is, it's probably not a valid source component)
   */
  // public async populateFilePaths(elements: ChangeResult[]): Promise<ChangeResult[]> {
  public populateTypesAndNames(elements: ChangeResult[], excludeUnresolvable = false): ChangeResult[] {
    if (elements.length === 0) {
      return [];
    }

    this.logger.debug(`populateTypesAndNames for ${elements.length} change elements`);
    // component set generated from the filenames on all local changes
    const resolver = new MetadataResolver();
    const sourceComponents = elements
      .map((element) => element.filenames)
      .flat()
      .filter(stringGuard)
      .map((filename) => {
        try {
          return resolver.getComponentsFromPath(filename);
        } catch (e) {
          // there will be some unresolvable files
          this.logger.warn(`unable to resolve ${filename}`);
          return undefined;
        }
      })
      .flat()
      .filter(sourceComponentGuard);

    this.logger.debug(` matching SourceComponents have ${sourceComponents.length} items from local`);

    // make it simpler to find things later
    const elementMap = new Map<string, ChangeResult>();
    elements.map((element) => {
      element.filenames?.map((filename) => {
        elementMap.set(this.ensureRelative(filename), element);
      });
    });

    // iterates the local components and sets their filenames
    sourceComponents.map((matchingComponent) => {
      if (matchingComponent?.fullName && matchingComponent?.type.name) {
        const filenamesFromMatchingComponent = [matchingComponent.xml, ...matchingComponent.walkContent()];
        filenamesFromMatchingComponent.map((filename) => {
          if (filename && elementMap.has(filename)) {
            // add the type/name from the componentSet onto the element
            elementMap.set(filename, {
              ...(elementMap.get(filename) as ChangeResult),
              type: matchingComponent.type.name,
              name: matchingComponent.fullName,
            });
          }
        });
      }
    });
    return excludeUnresolvable
      ? Array.from(new Set(elementMap.values())).filter((changeResult) => changeResult.name && changeResult.type)
      : Array.from(new Set(elementMap.values()));
  }

  public async getConflicts(): Promise<ChangeResult[]> {
    // we're going to need have both initialized
    await Promise.all([this.ensureRemoteTracking(), this.ensureLocalTracking()]);

    const localChanges = (
      await Promise.all([
        this.getChanges({ state: 'changed', origin: 'local' }),
        this.getChanges({ state: 'add', origin: 'local' }),
      ])
    ).flat();
    // remote adds won't have a filename
    const remoteChanges = this.populateFilePaths(await this.getChanges({ origin: 'remote', state: 'changed' }));

    // index them by filename
    const fileNameIndex = new Map<string, ChangeResult>();
    remoteChanges.map((change) => {
      change.filenames?.map((filename) => {
        fileNameIndex.set(filename, change);
      });
    });

    const conflicts = new Set<ChangeResult>();

    localChanges.map((change) => {
      change.filenames?.map((filename) => {
        if (fileNameIndex.has(filename)) {
          conflicts.add({ ...(fileNameIndex.get(filename) as ChangeResult) });
        }
      });
    });
    // deeply de-dupe
    return Array.from(conflicts);
  }

  private ensureRelative(filePath: string): string {
    return path.isAbsolute(filePath) ? path.relative(this.projectPath, filePath) : filePath;
  }
}

export const stringGuard = (input: string | undefined): input is string => {
  return typeof input === 'string';
};

const sourceComponentGuard = (input: SourceComponent | undefined): input is SourceComponent => {
  return input instanceof SourceComponent;
};