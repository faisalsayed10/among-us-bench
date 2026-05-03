// The Skeld — full map layout based on the blueprint.
// All coordinates shifted +405 from the blueprint so x is always positive.

export const MAP_BOUNDS = { x: 0, y: 0, width: 1786, height: 918 };

// Ship hull as a stylized silhouette wrapping every room.
// Engine notches on the left, Navigation prow on the right.
export const shipHull = [
  // Top edge (left → right)
  [105, 60],
  [205, 30], [355, 10],
  [605, -10], [905, -25], [1205, -10],
  [1405, 20], [1555, 80],
  // Right prow (Navigation area)
  [1685, 200], [1785, 380], [1785, 480], [1685, 660],
  // Bottom (right → left)
  [1555, 800], [1405, 870], [1205, 895], [905, 905],
  [605, 895], [355, 870], [205, 830],
  // Left side with two engine notches
  [105, 780],
  [45, 700], [25, 640],
  [10, 600], [25, 560],
  [45, 510],
  [25, 460], [10, 410], [25, 360],
  [45, 310], [25, 260],
  [25, 200], [45, 150],
];

export const engineExhausts = [
  { x: 10, y: 250, width: 35, height: 70 },   // upper engine notch
  { x: 10, y: 580, width: 35, height: 70 },   // lower engine notch
];

// ========================
// ROOM DEFINITIONS
// ========================
export const rooms = [
  {
    name: 'Cafeteria',
    floorColor: '#a5a797',
    floorAccent: '#969882',
    wallColor: '#4a5258',
    floorType: 'checkered',
    polygon: [
      [855, 40], [1055, 40],
      [1155, 140], [1155, 340],
      [1055, 440], [855, 440],
      [755, 340], [755, 140],
    ],
    label: [955, 95],
  },
  {
    name: 'Weapons',
    floorColor: '#a89c8a',
    floorAccent: '#988c7a',
    wallColor: '#5a4858',
    floorType: 'tile',
    // Octagon with longer right side where the cannons protrude.
    polygon: [
      [1275, 150], [1395, 150],
      [1455, 210], [1455, 270],
      [1395, 330], [1275, 330],
      [1245, 270], [1245, 210],
    ],
    label: [1345, 175],
  },
  {
    name: 'O2',
    floorColor: '#7a8a78',
    floorAccent: '#6a7a68',
    wallColor: '#3a5048',
    floorType: 'tile',
    polygon: [
      [1175, 280], [1240, 280],
      [1240, 410], [1175, 410],
    ],
    label: [1207, 298],
  },
  {
    name: 'Navigation',
    floorColor: '#5a7090',
    floorAccent: '#4a6080',
    wallColor: '#2a4868',
    floorType: 'tile',
    // Pointed pentagon — the prow of the ship.
    polygon: [
      [1546, 380], [1680, 361],
      [1755, 436],
      [1680, 511], [1546, 492],
    ],
    label: [1620, 400],
  },
  {
    name: 'Shields',
    floorColor: '#6a6890',
    floorAccent: '#5a5880',
    wallColor: '#3a3868',
    floorType: 'tile',
    // Octagon with chamfered corners.
    polygon: [
      [1297, 616], [1457, 616],
      [1477, 636], [1477, 746],
      [1457, 766], [1297, 766],
      [1277, 746], [1277, 636],
    ],
    label: [1377, 641],
  },
  {
    name: 'Communications',
    floorColor: '#5a6858',
    floorAccent: '#4a5848',
    wallColor: '#2a4030',
    floorType: 'tile',
    // Rectangle with a slanted top-right corner.
    polygon: [
      [1115, 726], [1239, 726],
      [1259, 746], [1259, 836],
      [1115, 836],
    ],
    label: [1187, 745],
  },
  {
    name: 'Admin',
    floorColor: '#683040',
    floorAccent: '#582838',
    wallColor: '#3a1820',
    floorType: 'carpet',
    // Pentagon with a slanted top-right corner.
    polygon: [
      [1090, 431], [1199, 431],
      [1219, 451], [1219, 603],
      [1090, 603],
    ],
    label: [1154, 451],
  },
  {
    name: 'Storage',
    floorColor: '#a08840',
    floorAccent: '#907838',
    wallColor: '#5a4818',
    floorType: 'storage_tile',
    // Rectangle with chamfered bottom corners (Skeld's signature shape).
    polygon: [
      [805, 566], [1077, 566],
      [1077, 858], [1057, 878],
      [825, 878], [805, 858],
    ],
    label: [940, 590],
  },
  {
    name: 'Electrical',
    floorColor: '#7a6a48',
    floorAccent: '#6a5a40',
    wallColor: '#3a3028',
    floorType: 'dirty',
    // Pentagon with chamfered top-right corner where the corridor enters.
    polygon: [
      [542, 519], [727, 519],
      [747, 539], [747, 698],
      [542, 698],
    ],
    label: [645, 540],
  },
  {
    name: 'MedBay',
    floorColor: '#72898a',
    floorAccent: '#628080',
    wallColor: '#4a5258',
    floorType: 'medical',
    // Pentagon: top-right corner cut where Cafeteria's south-west diagonal meets it.
    polygon: [
      [545, 320], [705, 320],
      [745, 360], [745, 500],
      [545, 500],
    ],
    label: [645, 340],
  },
  {
    name: 'Security',
    floorColor: '#5a5868',
    floorAccent: '#4a4858',
    wallColor: '#2a2838',
    floorType: 'metal',
    polygon: [
      [415, 357], [499, 357],
      [527, 437],
      [499, 517], [415, 517],
      [387, 437],
    ],
    label: [457, 380],
  },
  {
    name: 'Reactor',
    floorColor: '#4a3868',
    floorAccent: '#3a2858',
    wallColor: '#2a1a40',
    floorType: 'reactor',
    // Octagon with all four corners chamfered.
    polygon: [
      [60, 296], [220, 296],
      [240, 326], [240, 565],
      [220, 595], [60, 595],
      [40, 565], [40, 326],
    ],
    label: [140, 320],
  },
  {
    name: 'Upper Engine',
    floorColor: '#7a6a5a',
    floorAccent: '#6a5a4a',
    wallColor: '#3a3028',
    floorType: 'engine',
    // Hexagon with pointed left/right (toward hull engine notches and corridor).
    polygon: [
      [285, 180], [405, 180],
      [445, 240],
      [405, 300], [285, 300],
      [245, 240],
    ],
    label: [345, 200],
  },
  {
    name: 'Lower Engine',
    floorColor: '#7a6a5a',
    floorAccent: '#6a5a4a',
    wallColor: '#3a3028',
    floorType: 'engine',
    polygon: [
      [273, 610], [393, 610],
      [433, 667], [393, 725],
      [273, 725], [233, 667],
    ],
    label: [333, 628],
  },
];

// ========================
// HALLWAYS
// ========================
export const hallways = [
  { name: 'H-Cafe-Left',          polygon: [[435, 210], [755, 210], [755, 270], [435, 270]] },
  { name: 'H-Cafe-Weapons',       polygon: [[1150, 220], [1250, 220], [1250, 260], [1150, 260]] },
  { name: 'H-Weapons-South',      polygon: [[1305, 325], [1345, 325], [1345, 370], [1305, 370]] },
  { name: 'H-Weapons-Cross',      polygon: [[1225, 365], [1479, 365], [1479, 411], [1225, 411]] },
  { name: 'H-Corridor-MedBay',    polygon: [[620, 270], [670, 270], [670, 320], [620, 320]] },
  { name: 'H-Engine-Vertical',    polygon: [[307, 300], [357, 300], [357, 624], [307, 624]] },
  { name: 'H-Reactor-Connect',    polygon: [[240, 411], [408, 411], [408, 461], [240, 461]] },
  { name: 'H-LowerEng-East',      polygon: [[394, 641], [506, 641], [506, 691], [394, 691]] },
  { name: 'H-LowerEng-South',     polygon: [[455, 691], [506, 691], [506, 779], [455, 779]] },
  { name: 'H-Bottom',             polygon: [[455, 729], [805, 729], [805, 779], [455, 779]] },
  { name: 'H-Electrical-South',   polygon: [[620, 696], [670, 696], [670, 733], [620, 733]] },
  { name: 'H-Cafe-Storage',       polygon: [[926, 437], [976, 437], [976, 566], [926, 566]] },
  { name: 'H-Storage-Admin',      polygon: [[977, 476], [1108, 476], [1108, 526], [977, 526]] },
  { name: 'H-Storage-Comms',      polygon: [[1075, 653], [1303, 653], [1303, 705], [1075, 705]] },
  { name: 'H-Comms-Shields',      polygon: [[1184, 702], [1234, 702], [1234, 730], [1184, 730]] },
  { name: 'H-Cross-Shields',      polygon: [[1427, 368], [1477, 368], [1477, 484], [1427, 484]] },
  { name: 'H-Shields-Nav',        polygon: [[1333, 474], [1478, 474], [1478, 524], [1333, 524]] },
  { name: 'H-Nav-Vertical',       polygon: [[1333, 496], [1383, 496], [1383, 622], [1333, 622]] },
  { name: 'H-Nav-Entry',          polygon: [[1456, 413], [1616, 413], [1616, 463], [1456, 463]] },
];

export const hallwayStyle = {
  floorColor: '#4a5a62',
  wallColor: '#3a4850',
  dashColor: '#8a9aa2',
};

// ========================
// VENTS
// ========================
export const vents = [
  { x: 1120, y: 295, room: 'Cafeteria', id: 1 },
  { x: 570, y: 412, room: 'MedBay', id: 2 },
  { x: 1375, y: 250, room: 'Weapons', id: 3 },
  { x: 635, y: 670, room: 'Electrical', id: 4 },
  { x: 105, y: 320, room: 'Reactor', id: 5 },
  { x: 1585, y: 480, room: 'Navigation', id: 6 },
  { x: 1445, y: 740, room: 'Shields', id: 7 },
  { x: 465, y: 437, room: 'Security', id: 8 },
  { x: 825, y: 850, room: 'Storage', id: 9 },
  { x: 1135, y: 800, room: 'Communications', id: 10 },
];

export const ventConnections = [
  [1, 3, 8],
  [2, 4],
  [5, 9],
  [6, 7, 10],
];

// ========================
// TASKS
// ========================
export const tasks = [
  { x: 770, y: 230, room: 'Cafeteria', type: 'wiring', name: 'Fix Wiring' },
  { x: 705, y: 465, room: 'MedBay', type: 'common', name: 'Submit Scan' },
  { x: 1345, y: 245, room: 'Weapons', type: 'common', name: 'Clear Asteroids' },
  { x: 1207, y: 345, room: 'O2', type: 'common', name: 'Empty Garbage' },
  { x: 140, y: 445, room: 'Reactor', type: 'common', name: 'Start Reactor' },
  { x: 345, y: 240, room: 'Upper Engine', type: 'common', name: 'Align Engine' },
  { x: 333, y: 667, room: 'Lower Engine', type: 'common', name: 'Align Engine' },
  { x: 645, y: 608, room: 'Electrical', type: 'wiring', name: 'Fix Wiring' },
  { x: 940, y: 722, room: 'Storage', type: 'common', name: 'Refuel Engines' },
  { x: 1154, y: 517, room: 'Admin', type: 'common', name: 'Swipe Card' },
  { x: 1187, y: 781, room: 'Communications', type: 'common', name: 'Download Data' },
  { x: 1377, y: 691, room: 'Shields', type: 'common', name: 'Prime Shields' },
  { x: 1646, y: 436, room: 'Navigation', type: 'common', name: 'Chart Course' },
  { x: 457, y: 437, room: 'Security', type: 'common', name: 'Security Watch' },
];

// ========================
// CAMERAS
// ========================
export const cameras = [
  { x: 865, y: 60, room: 'Cafeteria' },
  { x: 865, y: 870, room: 'Storage' },
  { x: 1465, y: 770, room: 'Shields' },
  { x: 285, y: 590, room: 'Reactor' },
];

// ========================
// EMERGENCY BUTTON
// ========================
export const emergencyButton = { x: 955, y: 240 };

// ========================
// DOORS
// ========================
export const doors = [
  { x: 1155, y: 240, horizontal: false },
  { x: 755, y: 240, horizontal: false },
  { x: 1245, y: 240, horizontal: false },
  { x: 645, y: 320, horizontal: true },
  { x: 1325, y: 330, horizontal: true },
  { x: 940, y: 566, horizontal: true },
  { x: 803, y: 754, horizontal: false },
  { x: 1077, y: 678, horizontal: false },
  { x: 1090, y: 501, horizontal: false },
  { x: 645, y: 698, horizontal: true },
  { x: 1377, y: 616, horizontal: true },
  { x: 1277, y: 691, horizontal: false },
  { x: 1546, y: 438, horizontal: false },
  { x: 1187, y: 726, horizontal: true },
  { x: 457, y: 437, horizontal: true },
  { x: 345, y: 300, horizontal: true },
  { x: 333, y: 610, horizontal: true },
  { x: 240, y: 436, horizontal: false },
];

// ========================
// ROOM ADJACENCY
// ========================
export const adjacency = {
  'Cafeteria': ['MedBay', 'Weapons', 'Upper Engine', 'Admin'],
  'Weapons': ['Cafeteria', 'O2', 'Navigation', 'Shields'],
  'O2': ['Weapons', 'Navigation'],
  'Navigation': ['O2', 'Weapons', 'Shields'],
  'Shields': ['Navigation', 'Communications', 'Weapons'],
  'Communications': ['Shields', 'Storage'],
  'Admin': ['Cafeteria', 'Storage'],
  'Storage': ['Admin', 'Electrical', 'Communications'],
  'Electrical': ['Storage', 'MedBay', 'Lower Engine'],
  'MedBay': ['Cafeteria', 'Security'],
  'Security': ['MedBay', 'Reactor', 'Upper Engine', 'Lower Engine'],
  'Reactor': ['Security', 'Upper Engine', 'Lower Engine'],
  'Upper Engine': ['Cafeteria', 'Reactor', 'Security'],
  'Lower Engine': ['Reactor', 'Security', 'Electrical'],
};
