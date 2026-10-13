import { TFile } from 'obsidian';

export function shouldIndexFile(file: TFile, includeFolders: string[], excludeFolders: string[], excludePatterns: string[]): boolean {
  const path = file.path;
  // include
  if (includeFolders.length === 1 && includeFolders[0] === '') {
    // whole vault
  } else {
    const included = includeFolders.some(inc => {
      if (!inc) return true;
      return path.startsWith(inc + '/') || path === inc;
    });
    if (!included) return false;
  }
  // exclude folders
  for (const ex of excludeFolders) {
    if (path.startsWith(ex + '/') || path === ex) return false;
  }
  // exclude patterns
  for (const pat of excludePatterns) {
    if (path.includes(pat)) return false;
  }
  return true;
}
