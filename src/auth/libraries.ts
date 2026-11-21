import type { PhotoLibrary } from "../library/PhotoLibrary.js";
import { sha256 } from "./seal.js";

/**
 * One {@link PhotoLibrary} per Immich API key.
 *
 * A library caches album and place names, and those differ per person, so
 * callers must never share one. The least recently used library is dropped
 * once the pool is full; its caches are simply rebuilt on the next call.
 */
export class LibraryPool {
  private readonly libraries = new Map<string, PhotoLibrary>();

  constructor(
    private readonly create: (apiKey: string) => PhotoLibrary,
    private readonly max = 100,
  ) {}

  for(apiKey: string): PhotoLibrary {
    const id = sha256(apiKey);
    let library = this.libraries.get(id);
    if (library) {
      this.libraries.delete(id);
    } else {
      library = this.create(apiKey);
      if (this.libraries.size >= this.max) {
        const oldest = this.libraries.keys().next().value;
        if (oldest !== undefined) this.libraries.delete(oldest);
      }
    }
    this.libraries.set(id, library);
    return library;
  }

  get size(): number {
    return this.libraries.size;
  }
}
