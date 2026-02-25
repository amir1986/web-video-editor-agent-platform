import React, { useState, useEffect } from 'react';
import './App.css';

// Import ProjectState type from core
import { ProjectState } from '../../packages/core';

// Import IndexedDB utilities
import { saveProjectState as saveToDB, loadProjectState as loadFromDB } from './utils/indexedDB';

function App() {
  // Initialize with default project state
  const [projectState, setProjectState] = useState<ProjectState>({
    clips: [],
    inOut: { in: 0, out: 10 },
    titles: [],
    exports: [],
  });

  // Load project state from IndexedDB on component mount
  useEffect(() => {
    const loadProjectState = async () => {
      try {
        const savedState = await loadFromDB();
        if (savedState) {
          setProjectState(savedState);
        }
      } catch (error) {
        console.error('Failed to load project state:', error);
      }
    };

    loadProjectState();
  }, []);

  // Save project state to IndexedDB
  const saveProjectState = async (newState: ProjectState) => {
    try {
      await saveToDB(newState);
      setProjectState(newState);
    } catch (error) {
      console.error('Failed to save project state:', error);
    }
  };

  return (
    <div className="app">
      <div className="panel assets-panel">
        <h2>Assets Panel</h2>
        <p>Video clips and media assets</p>
      </div>

      <div className="panel preview-panel">
        <h2>Preview Area</h2>
        <p>Video preview player</p>
      </div>

      <div className="panel timeline-panel">
        <h2>Timeline Area</h2>
        <p>Timeline editing</p>
      </div>

      <div className="panel agent-panel">
        <h2>Agent Panel</h2>
        <p>Agent suggestions and controls</p>
      </div>
    </div>
  );
}

export default App;