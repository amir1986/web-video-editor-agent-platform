// Project state types
export interface ProjectState {
  clips: Clip[];
  inOut: InOut;
  titles: Title[];
  exports: Export[];
}

export interface Clip {
  id: string;
  name: string;
  duration: number; // in seconds
  path: string;
}

export interface InOut {
  in: number; // in seconds
  out: number; // in seconds
}

export interface Title {
  id: string;
  text: string;
  position: { x: number; y: number };
  fontSize: number;
}

export interface Export {
  id: string;
  status: 'pending' | 'in-progress' | 'completed' | 'failed';
  outputPath: string;
  duration: number; // in seconds
}