/**
 * file-move.ts — moving a file or folder, across drives too.
 *
 * fs.rename fails with EXDEV when source and destination are on different
 * volumes (C: → D:, or deleting a file on D: into the trash folder under the
 * home directory). delete_file / move_file / rename_file then reported an
 * error for an ordinary request. On EXDEV: copy, then remove the source.
 * No Electron: `fsImpl` is injectable so the EXDEV path unit-tests.
 */
import fs from 'fs';

type FsLike = Pick<typeof fs, 'renameSync' | 'statSync' | 'cpSync' | 'rmSync' | 'copyFileSync' | 'unlinkSync'>;

/** Move `from` to `to`. Never replaces an existing `to` on the copy path (the caller checks first). */
export function moveAcrossDevices(from: string, to: string, fsImpl: FsLike = fs): 'renamed' | 'copied' {
  try {
    fsImpl.renameSync(from, to);
    return 'renamed';
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
  }
  if (fsImpl.statSync(from).isDirectory()) {
    fsImpl.cpSync(from, to, { recursive: true, force: false, errorOnExist: true });
    fsImpl.rmSync(from, { recursive: true, force: true });
  } else {
    fsImpl.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    fsImpl.unlinkSync(from);
  }
  return 'copied';
}
