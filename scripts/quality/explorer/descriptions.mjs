export const descriptions = {
  'src/client/app.mjs': [
    'Reading screen',
    'Coordinates the buttons, reading view and document workspace you interact with.',
  ],
  'src/client/api.mjs': [
    'Browser requests',
    'Sends requests to Reader’s local server and handles its session and errors.',
  ],
  'src/client/canvas-ui.mjs': [
    'Canvas course panel',
    'Displays courses and assignments and connects their controls to the reading workspace.',
  ],
  'src/client/documents.mjs': [
    'Document controls',
    'Handles document selection, display and related browser interactions.',
  ],
  'src/client/pdf-workspace.mjs': [
    'PDF workspace',
    'Displays PDF pages and keeps their reading position and selection together.',
  ],
  'src/client/speech.mjs': [
    'Read aloud',
    'Controls the browser’s reading voice, playback and cancellation.',
  ],
  'src/client/submission-ui.mjs': [
    'Submission form',
    'Collects the user’s assignment submission choices.',
  ],
  'src/server/index.mjs': [
    'Start the app',
    'The small entry point that starts the local HTTP server.',
  ],
  'src/server/http.mjs': [
    'Request router',
    'Receives browser requests and sends each one to its feature handler.',
  ],
  'src/server/security.mjs': [
    'Request checks',
    'Checks origins, sessions and request limits before protected actions proceed.',
  ],
  'src/server/canvas.mjs': [
    'Canvas adapter',
    'Coordinates the allowed Canvas reads and normalizes their results.',
  ],
  'src/server/canvas-download.mjs': [
    'Canvas downloads',
    'Retrieves permitted course files with the existing download checks.',
  ],
  'src/server/owner-canvas.mjs': [
    'Canvas configuration',
    'Loads this app’s explicitly provisioned Canvas configuration on the server.',
  ],
  'src/server/document-processing.mjs': [
    'Document processing',
    'Coordinates supported document extraction and conversion jobs.',
  ],
  'src/server/retrieval.mjs': [
    'Find relevant passages',
    'Passes a bounded document question to the Python retrieval job.',
  ],
  'src/server/study.mjs': [
    'Study service',
    'Coordinates study preparation and the optional, consented AI path.',
  ],
  'src/server/submissions.mjs': [
    'Submission service',
    'Handles the existing submission workflow on the server.',
  ],
  'src/server/python-domain.mjs': [
    'Python bridge',
    'Runs fixed, allowlisted Python jobs using bounded JSON messages and cancellation.',
  ],
  'src/server/python-presentation.mjs': [
    'Presentation bridge',
    'Coordinates the Python presentation-writing worker.',
  ],
  'src/python/worker.py': [
    'Python job dispatcher',
    'Reads one allowed JSON job, calls the correct Python function and returns its result.',
  ],
  'src/python/common.py': [
    'Python validation',
    'Supplies shared validation, size limits and structured errors.',
  ],
  'src/python/canvas_records.py': [
    'Canvas record cleanup',
    'Converts allowed Canvas responses into the app’s consistent data shapes.',
  ],
  'src/python/retrieval.py': [
    'Passage matching',
    'Finds relevant material inside the supplied text without inventing missing source content.',
  ],
  'src/python/study.py': [
    'Study preparation',
    'Prepares and validates source-bound reading and study material.',
  ],
  'src/python/presentation.py': [
    'Presentation writer',
    'Creates presentation output from the supplied bounded input.',
  ],
  'src/core/cli-protocol.ts': [
    'Optional AI protocol',
    'Validates the text-only CLI request and response format for the explicitly enabled AI path.',
  ],
  'src/core/cli-runner.ts': [
    'Optional AI runner',
    'Runs that consented CLI request with its existing isolation and cancellation controls.',
  ],
};
export const stories = [
  [
    'Ask about a document',
    [
      'src/client/app.mjs',
      'src/client/api.mjs',
      'src/server/http.mjs',
      'src/server/retrieval.mjs',
      'src/server/python-domain.mjs',
      'src/python/worker.py',
      'src/python/retrieval.py',
    ],
  ],
  [
    'Read a Canvas assignment',
    [
      'src/client/canvas-ui.mjs',
      'src/client/api.mjs',
      'src/server/http.mjs',
      'src/server/canvas.mjs',
      'src/server/python-domain.mjs',
      'src/python/worker.py',
      'src/python/canvas_records.py',
    ],
  ],
  [
    'Create a presentation',
    [
      'src/client/app.mjs',
      'src/client/api.mjs',
      'src/server/http.mjs',
      'src/server/document-processing.mjs',
      'src/server/python-presentation.mjs',
      'src/python/presentation.py',
    ],
  ],
];
