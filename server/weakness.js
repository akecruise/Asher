'use strict';
/**
 * Weakness Engine
 *
 * ไม่ได้หาแค่จุดอ่อนคู่แข่ง แต่หาจุดที่ "เขาอ่อน และเรามีของดีกว่าจริง"
 *
 *   priority = severity x exploitability
 *
 * severity      มาจากข้อมูลคู่แข่งเทียบกับมาตรฐานตลาด — รู้ได้โดยไม่ต้องมีข้อมูลเรา
 * exploitability ถูกล็อกไว้ที่ 2 จนกว่าจะมีห้องของ ASHER (จาก /api/asher/rooms)
 *                มายืนยันว่าเราชนะมิตินั้นจริง
 */

const LOCKED_EXPLOITABILITY = 2;
const MAX_EXPLOITABILITY = 5;

/** มาตรฐานตลาดคอนโดกรุงเทพ ใช้เป็นเส้นตัดว่า "เล็กกว่ามาตรฐาน" */
const SIZE_STANDARD = { studio: 26, '1': 30, '2': 50, '3': 75, '4': 100 };
const CEILING_STANDARD = 2.7;
const DENSITY_STANDARD = 20; // ยูนิตต่อชั้น
const CORE_FACILITIES = [
  'สระว่ายน้ำ', 'ฟิตเนส', 'Co-Working Space', 'ที่จอดรถ', 'ระบบรักษาความปลอดภัย 24 ชม.'
];

const CLASS_LABELS = {
  studio: 'Studio', '1': '1 Bedroom', '2': '2 Bedroom', '3': '3 Bedroom', '4': '4 Bedroom'
};

/* ----------------------------- ตัวช่วยเล็ก ๆ ----------------------------- */

function fmt(value, digits) {
  if (value === null || value === undefined) return '—';
  var n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('th-TH', {
    minimumFractionDigits: digits || 0,
    maximumFractionDigits: digits === undefined ? 0 : digits
  });
}

function fmtBaht(value) {
  if (!value) return '—';
  if (value >= 1000000) {
    var millions = value / 1000000;
    return (Math.round(millions * 100) / 100).toLocaleString('th-TH') + ' ล้าน';
  }
  return fmt(value) + ' บาท';
}

/** แปลงชื่อผังห้องเป็นคลาสที่เทียบกันได้ เช่น "1 Bedroom (S)" -> "1" */
function roomClass(type) {
  var value = String(type || '').toLowerCase();
  if (/studio|สตูดิโอ/.test(value)) return 'studio';
  var match = value.match(/([1-4])\s*(?:bed|br|ห้องนอน)/);
  if (match) return match[1];
  var bare = value.match(/^\s*([1-4])\b/);
  return bare ? bare[1] : null;
}

function pricePerSqm(room) {
  if (room.pricePerSqmTHB) return room.pricePerSqmTHB;
  if (room.priceTHB && room.sizeSqm) return Math.round(room.priceTHB / room.sizeSqm);
  return null;
}

function tier(value, thresholds) {
  // thresholds เรียงจากมากไปน้อย: [[เกณฑ์, คะแนน], ...]
  for (var i = 0; i < thresholds.length; i += 1) {
    if (value >= thresholds[i][0]) return thresholds[i][1];
  }
  return 0;
}

function median(values) {
  if (!values.length) return null;
  var sorted = values.slice().sort(function (a, b) { return a - b; });
  var mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/* --------------------------- ห้องฝั่ง ASHER --------------------------- */

/**
 * แปลงห้องจาก /api/asher/rooms เป็นดัชนีที่ค้นตามคลาสห้องได้
 * ห้องที่ไม่มีขนาด ตร.ม. ถือว่ายังพิสูจน์อะไรไม่ได้ — ตัดออกตั้งแต่ต้น
 */
function indexAsherRooms(projects) {
  var byClass = {};
  var all = [];
  (projects || []).forEach(function (project) {
    (project.rooms || []).forEach(function (room) {
      if (!room.sizeSqm) return;
      var entry = {
        projectId: project.id,
        projectName: project.name,
        location: project.location,
        facilities: project.facilities || [],
        type: room.type,
        sizeSqm: room.sizeSqm,
        ceilingHeightM: room.ceilingHeightM,
        priceTHB: room.priceTHB,
        pricePerSqmTHB: pricePerSqm(room),
        bedWidthFt: room.bedWidthFt,
        cls: roomClass(room.type)
      };
      all.push(entry);
      if (entry.cls) {
        if (!byClass[entry.cls]) byClass[entry.cls] = [];
        byClass[entry.cls].push(entry);
      }
    });
  });
  return { all: all, byClass: byClass };
}

/** หาห้องของเราที่ใหญ่ที่สุดในคลาสเดียวกัน — ใช้เป็นหมัดที่หนักที่สุดที่มี */
function bestBySize(index, cls) {
  var candidates = index.byClass[cls] || [];
  return candidates.reduce(function (best, room) {
    return !best || room.sizeSqm > best.sizeSqm ? room : best;
  }, null);
}

function bestBy(index, cls, key) {
  var candidates = index.byClass[cls] || [];
  return candidates.reduce(function (best, room) {
    if (!room[key]) return best;
    return !best || room[key] > best[key] ? room : best;
  }, null);
}

function cheapestPerSqm(index, cls) {
  var candidates = index.byClass[cls] || [];
  return candidates.reduce(function (best, room) {
    if (!room.pricePerSqmTHB) return best;
    return !best || room.pricePerSqmTHB < best.pricePerSqmTHB ? room : best;
  }, null);
}

/* ------------------------------- กติกา ------------------------------- */

function lockedProof(dimension) {
  return {
    proven: false,
    exploitability: LOCKED_EXPLOITABILITY,
    proof: 'ยังไม่มีข้อมูล ASHER ที่ชนะมิตินี้ — exploitability ถูกล็อกไว้ที่ ' +
      LOCKED_EXPLOITABILITY + ' (ต้องกรอก' + dimension + 'ก่อน)',
    angle: null,
    ourRoom: null
  };
}

function bump(exploitability, condition) {
  return condition ? Math.min(MAX_EXPLOITABILITY, exploitability + 1) : exploitability;
}

/**
 * คำถามเปิดต้องเข้ากับขนาดห้อง — ถามเรื่องเตียง 6 ฟุตกับห้อง 2 นอน 44 ตร.ม. แล้วเสียเครดิต
 */
function sizeQuestion(cls, sizeSqm) {
  var size = fmt(sizeSqm, 1);
  if (cls === 'studio' || cls === '1') {
    return 'ลองวางเตียง 6 ฟุตในห้อง ' + size + ' ตร.ม. แล้วเหลือทางเดินกี่เซนติเมตรครับ';
  }
  if (cls === '2') {
    return 'ห้อง 2 นอน ' + size + ' ตร.ม. พอวางโซฟากับโต๊ะกินข้าวพร้อมกันแล้ว ' +
      'ทางเดินเข้าห้องนอนเหลือเท่าไหร่ครับ';
  }
  return 'ห้อง ' + size + ' ตร.ม. หารกับจำนวนห้องนอนแล้ว แต่ละห้องเหลือพื้นที่จริงกี่ตารางเมตรครับ';
}

/** จุดอ่อน 1: ห้องเล็กกว่ามาตรฐาน */
function ruleRoomSize(room, competitor, index) {
  var cls = roomClass(room.type);
  if (!cls || !room.sizeSqm) return null;
  var standard = SIZE_STANDARD[cls];
  if (!standard) return null;

  var deficit = standard - room.sizeSqm;
  if (deficit <= 0) return null;

  var severity = tier(deficit / standard, [[0.3, 5], [0.15, 4], [0.07, 3], [0.0001, 2]]);
  if (!severity) return null;

  var ours = bestBySize(index, cls);
  var proof;
  if (!ours || ours.sizeSqm <= room.sizeSqm) {
    proof = lockedProof('ขนาด ตร.ม. ของห้องเรา');
  } else {
    var margin = (ours.sizeSqm - room.sizeSqm) / room.sizeSqm;
    var exploitability = tier(margin, [[0.15, 5], [0.08, 4], [0.0001, 3]]);
    var cheaperPerSqm = ours.pricePerSqmTHB && pricePerSqm(room) &&
      ours.pricePerSqmTHB <= pricePerSqm(room);
    proof = {
      proven: true,
      exploitability: bump(exploitability, cheaperPerSqm),
      proof: 'พิสูจน์ได้: ' + ours.projectName + ' ห้อง ' + ours.type + ' ขนาด ' +
        fmt(ours.sizeSqm, 1) + ' ตร.ม. — ใหญ่กว่า ' +
        fmt(ours.sizeSqm - room.sizeSqm, 1) + ' ตร.ม. (' + Math.round(margin * 100) + '%)' +
        (cheaperPerSqm ? ' และราคาต่อ ตร.ม. ยังถูกกว่า' : ''),
      angle: ours.projectName + (ours.location ? ' (' + ours.location + ')' : '') +
        ' ให้พื้นที่ใช้สอยมากกว่า ' + fmt(ours.sizeSqm - room.sizeSqm, 1) +
        ' ตร.ม. ในงบใกล้กัน วางเฟอร์ครบโดยไม่ต้องตัดของ',
      ourRoom: ours
    };
  }

  return Object.assign({
    rule: 'room-size',
    key: 'room-size:' + (room.type || cls),
    title: 'ห้องเล็กกว่ามาตรฐานอยู่จริง',
    roomLabel: room.type || CLASS_LABELS[cls],
    severity: severity,
    evidence: 'ห้อง ' + (room.type || CLASS_LABELS[cls]) + ' ขนาด ' + fmt(room.sizeSqm, 1) +
      ' ตร.ม. (มาตรฐาน ' + CLASS_LABELS[cls] + ' อยู่ที่ ' + standard + ' ตร.ม.)',
    openQuestion: sizeQuestion(cls, room.sizeSqm),
    doNotSay: 'พูดถึงพื้นที่ของเราเท่านั้น อย่าบอกว่าห้องเขา "อยู่ไม่ได้" — ลูกค้าบางคนซื้อไปแล้ว'
  }, proof);
}

/** จุดอ่อน 2: ฝ้าเตี้ย */
function ruleCeiling(room, competitor, index) {
  if (!room.ceilingHeightM) return null;
  var deficit = CEILING_STANDARD - room.ceilingHeightM;
  var severity = tier(deficit, [[0.35, 5], [0.25, 4], [0.15, 3], [0.05, 2]]);
  if (!severity) return null;

  var cls = roomClass(room.type);
  var ours = cls ? bestBy(index, cls, 'ceilingHeightM') : null;
  var proof;
  if (!ours || ours.ceilingHeightM <= room.ceilingHeightM) {
    proof = lockedProof('ความสูงฝ้าของห้องเรา');
  } else {
    var diff = ours.ceilingHeightM - room.ceilingHeightM;
    proof = {
      proven: true,
      exploitability: tier(diff, [[0.3, 5], [0.15, 4], [0.0001, 3]]),
      proof: 'พิสูจน์ได้: ' + ours.projectName + ' ห้อง ' + ours.type + ' ฝ้าสูง ' +
        fmt(ours.ceilingHeightM, 2) + ' ม. — สูงกว่า ' + fmt(diff, 2) + ' ม.',
      angle: ours.projectName + ' ฝ้าสูง ' + fmt(ours.ceilingHeightM, 2) +
        ' ม. พาลูกค้ายืนกลางห้องแล้วให้เขารู้สึกเอง ไม่ต้องอธิบายเยอะ',
      ourRoom: ours
    };
  }

  return Object.assign({
    rule: 'ceiling-height',
    key: 'ceiling:' + (room.type || 'all'),
    title: 'ฝ้าเตี้ย ทำให้ห้องอึดอัด',
    roomLabel: room.type || '—',
    severity: severity,
    evidence: 'ฝ้าสูง ' + fmt(room.ceilingHeightM, 2) + ' ม. ในห้อง ' + (room.type || '—') +
      ' (มาตรฐาน ' + CEILING_STANDARD.toFixed(2) + ' ม.)',
    openQuestion: 'ห้องที่ฝ้า ' + fmt(room.ceilingHeightM, 2) +
      ' ม. กับ ' + fmt(CEILING_STANDARD, 2) + ' ม. ลองยืนเทียบดูต่างกันแค่ไหนครับ',
    doNotSay: 'อย่าล้อเรื่องความสูงของลูกค้า และอย่าพูดว่า "อึดอัด" ใส่โครงการเขาตรง ๆ'
  }, proof);
}

/** จุดอ่อน 3: จ่ายแพงกว่าต่อตารางเมตร */
function rulePricePerSqm(room, competitor, index, context) {
  var theirs = pricePerSqm(room);
  if (!theirs || !context.marketMedianPricePerSqm) return null;

  var excess = (theirs - context.marketMedianPricePerSqm) / context.marketMedianPricePerSqm;
  var severity = tier(excess, [[0.2, 5], [0.12, 4], [0.06, 3], [0.03, 2]]);
  if (!severity) return null;

  var cls = roomClass(room.type);
  var ours = cls ? cheapestPerSqm(index, cls) : null;
  var proof;
  if (!ours || ours.pricePerSqmTHB >= theirs) {
    proof = lockedProof('ราคาต่อ ตร.ม. ของห้องเรา');
  } else {
    var save = theirs - ours.pricePerSqmTHB;
    proof = {
      proven: true,
      exploitability: tier(save / theirs, [[0.12, 5], [0.06, 4], [0.0001, 3]]),
      proof: 'พิสูจน์ได้: ' + ours.projectName + ' ห้อง ' + ours.type + ' อยู่ที่ ' +
        fmt(ours.pricePerSqmTHB) + ' บาท/ตร.ม. — ถูกกว่า ' + fmt(save) + ' บาท/ตร.ม.',
      angle: 'ที่งบเท่ากัน ' + ours.projectName + ' ได้พื้นที่มากกว่า — คิดเป็นส่วนต่าง ' +
        fmt(save) + ' บาทต่อ ตร.ม. ลองคูณกับขนาดห้องที่ลูกค้าสนใจให้เขาเห็นตัวเลข',
      ourRoom: ours
    };
  }

  return Object.assign({
    rule: 'price-per-sqm',
    key: 'price-sqm:' + (room.type || cls || 'all'),
    title: 'ราคาต่อตารางเมตรสูงกว่าตลาด',
    roomLabel: room.type || '—',
    severity: severity,
    evidence: 'ห้อง ' + (room.type || '—') + ' อยู่ที่ ' + fmt(theirs) +
      ' บาท/ตร.ม. สูงกว่าค่ากลางของคู่แข่งในชุดข้อมูล (' +
      fmt(context.marketMedianPricePerSqm) + ' บาท/ตร.ม.) อยู่ ' + Math.round(excess * 100) + '%',
    openQuestion: 'งบที่ลูกค้าตั้งไว้ ถ้าคิดเป็นพื้นที่ที่ได้จริง ต่างกันกี่ตารางเมตรครับ',
    doNotSay: 'อย่าบอกว่าโครงการเขา "โก่งราคา" — เทียบตัวเลขต่อ ตร.ม. เฉย ๆ ก็พอ'
  }, proof);
}

/** จุดอ่อน 4: ส่วนกลางหลักที่เขาไม่มี */
function ruleFacilityGap(competitor, index, asherProjects) {
  var theirs = (competitor.facilities || []).map(function (f) { return f.toLowerCase(); });
  if (!theirs.length) return []; // ยังไม่รู้ว่าเขามีอะไรบ้าง = ยังไม่ใช่จุดอ่อน

  var ourFacilities = [];
  (asherProjects || []).forEach(function (project) {
    (project.facilities || []).forEach(function (facility) {
      if (ourFacilities.indexOf(facility) === -1) ourFacilities.push(facility);
    });
  });

  return CORE_FACILITIES.filter(function (facility) {
    return theirs.indexOf(facility.toLowerCase()) === -1;
  }).map(function (facility) {
    var weHaveIt = ourFacilities.some(function (f) {
      return f.toLowerCase() === facility.toLowerCase();
    });
    var proof = weHaveIt
      ? {
          proven: true,
          exploitability: 4,
          proof: 'พิสูจน์ได้: โครงการ ASHER มี "' + facility + '" อยู่ในรายการส่วนกลาง',
          angle: 'พาลูกค้าดู ' + facility + ' ของเราจริง ๆ แล้วถามว่าใช้บ่อยแค่ไหนในหนึ่งสัปดาห์',
          ourRoom: null
        }
      : lockedProof('รายการส่วนกลางของโครงการเรา');
    return Object.assign({
      rule: 'facility-gap',
      key: 'facility:' + facility,
      title: 'ไม่มี ' + facility + ' ในส่วนกลาง',
      roomLabel: 'ส่วนกลาง',
      severity: 3,
      evidence: 'รายการส่วนกลางที่บันทึกไว้ของ ' + competitor.name + ' (' +
        (competitor.facilities || []).length + ' รายการ) ไม่มี "' + facility + '"',
      openQuestion: 'ในหนึ่งสัปดาห์ คุณคิดว่าจะได้ใช้ ' + facility + ' กี่ครั้งครับ',
      doNotSay: 'อย่าเดาแทนเขาว่า "ไม่มีแน่นอน" ถ้าข้อมูลส่วนกลางที่เรามียังไม่ครบ'
    }, proof);
  });
}

/** จุดอ่อน 5: ยูนิตต่อชั้นแน่น */
function ruleDensity(competitor, index, asherProjects) {
  if (!competitor.unitsTotal || !competitor.floors) return null;
  var density = competitor.unitsTotal / competitor.floors;
  var severity = tier(density - DENSITY_STANDARD, [[15, 5], [10, 4], [5, 3], [0.5, 2]]);
  if (!severity) return null;

  var ourBest = (asherProjects || []).reduce(function (best, project) {
    if (!project.unitsTotal || !project.floors) return best;
    var value = project.unitsTotal / project.floors;
    return !best || value < best.density ? { project: project, density: value } : best;
  }, null);

  var proof;
  if (!ourBest || ourBest.density >= density) {
    proof = lockedProof('จำนวนยูนิตและจำนวนชั้นของโครงการเรา');
  } else {
    proof = {
      proven: true,
      exploitability: tier((density - ourBest.density) / density, [[0.3, 5], [0.15, 4], [0.0001, 3]]),
      proof: 'พิสูจน์ได้: ' + ourBest.project.name + ' อยู่ที่ ' + fmt(ourBest.density, 1) +
        ' ยูนิตต่อชั้น — น้อยกว่า ' + fmt(density - ourBest.density, 1) + ' ยูนิตต่อชั้น',
      angle: ourBest.project.name + ' คนต่อชั้นน้อยกว่า ทั้งลิฟต์ตอนเช้าและทางเดินหน้าห้องต่างกันจริง',
      ourRoom: null
    };
  }

  return Object.assign({
    rule: 'unit-density',
    key: 'density',
    title: 'ยูนิตต่อชั้นแน่น ลิฟต์ตอนเช้าจะหนัก',
    roomLabel: 'ทั้งโครงการ',
    severity: severity,
    evidence: fmt(competitor.unitsTotal) + ' ยูนิต บน ' + fmt(competitor.floors) + ' ชั้น = ' +
      fmt(density, 1) + ' ยูนิตต่อชั้น (มาตรฐานที่ใช้เทียบ ' + DENSITY_STANDARD + ')',
    openQuestion: 'ช่วงเช้าวันธรรมดา คุณออกจากบ้านกี่โมงครับ รอลิฟต์นานแค่ไหนถึงจะรับได้',
    doNotSay: 'อย่าพูดว่าโครงการเขา "แออัด" — ใช้ตัวเลขยูนิตต่อชั้นแทน'
  }, proof);
}

/* ------------------------------ ตัวรัน ------------------------------ */

function analyze(input) {
  var asherProjects = input.asherProjects || [];
  var competitors = input.competitors || [];
  var actions = (input.actions && input.actions.items) || {};

  var index = indexAsherRooms(asherProjects);

  var allCompetitorPricesPerSqm = [];
  competitors.forEach(function (competitor) {
    (competitor.rooms || []).forEach(function (room) {
      var value = pricePerSqm(room);
      if (value) allCompetitorPricesPerSqm.push(value);
    });
  });
  var context = {
    marketMedianPricePerSqm: allCompetitorPricesPerSqm.length >= 3
      ? median(allCompetitorPricesPerSqm)
      : null
  };

  var findings = [];
  competitors.forEach(function (competitor) {
    var raw = [];
    (competitor.rooms || []).forEach(function (room) {
      raw.push(ruleRoomSize(room, competitor, index));
      raw.push(ruleCeiling(room, competitor, index));
      raw.push(rulePricePerSqm(room, competitor, index, context));
    });
    raw = raw.concat(ruleFacilityGap(competitor, index, asherProjects));
    raw.push(ruleDensity(competitor, index, asherProjects));

    raw.filter(Boolean).forEach(function (finding) {
      var id = competitor.id + '::' + finding.key;
      var action = actions[id] || null;
      findings.push(Object.assign({}, finding, {
        id: id,
        competitorId: competitor.id,
        competitorName: competitor.name,
        competitorLocation: competitor.location,
        competitorWebsite: competitor.website,
        priority: finding.severity * finding.exploitability,
        potentialPriority: finding.severity * MAX_EXPLOITABILITY,
        locked: !finding.proven,
        status: action ? action.status : 'new',
        outcome: action ? action.outcome : null,
        actionUpdatedAt: action ? action.updatedAt : null
      }));
    });
  });

  findings.sort(function (a, b) {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return b.severity - a.severity;
  });

  var visible = findings.filter(function (f) { return f.status !== 'dismissed'; });
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    inputs: {
      asherProjects: asherProjects.length,
      asherRoomsWithSize: index.all.length,
      competitors: competitors.length,
      competitorRooms: competitors.reduce(function (sum, c) { return sum + (c.rooms || []).length; }, 0),
      marketMedianPricePerSqm: context.marketMedianPricePerSqm
    },
    summary: {
      ready: visible.filter(function (f) { return f.priority >= 15; }).length,
      interesting: visible.filter(function (f) { return f.priority >= 8 && f.priority < 15; }).length,
      used: findings.filter(function (f) { return f.status === 'used'; }).length,
      won: findings.filter(function (f) { return f.outcome === 'won'; }).length,
      locked: visible.filter(function (f) { return f.locked; }).length,
      dismissed: findings.filter(function (f) { return f.status === 'dismissed'; }).length
    },
    blockers: buildBlockers(index, competitors, context, visible),
    findings: findings
  };
}

function buildBlockers(index, competitors, context, visible) {
  var blockers = [];
  if (!competitors.length) {
    blockers.push('ยังไม่มีข้อมูลคู่แข่งในระบบ — เพิ่มคู่แข่งก่อนถึงจะสแกนจุดอ่อนได้');
  }
  if (!index.all.length) {
    blockers.push('ยังไม่มีข้อมูลห้องของ ASHER ในระบบ — จุดอ่อนทุกข้อจึงถูกล็อก exploitability ไว้ที่ ' +
      LOCKED_EXPLOITABILITY + ' เพราะระบบยังพิสูจน์ไม่ได้ว่าเราชนะจริง');
  } else {
    var lockedCount = visible.filter(function (f) { return f.locked; }).length;
    if (lockedCount) {
      blockers.push(lockedCount + ' จุดอ่อนยังพิสูจน์ไม่ได้ — ต้องเติมข้อมูลห้อง ASHER ' +
        'ให้ครบมิติที่ขาด (ขนาด ตร.ม. / ความสูงฝ้า / ราคาต่อ ตร.ม.) ที่หน้าใส่ข้อมูลโครงการ');
    }
    if (!index.all.some(function (room) { return room.ceilingHeightM; })) {
      blockers.push('ห้องของ ASHER ยังไม่มีความสูงฝ้าเลย — จุดอ่อนเรื่องฝ้าเตี้ยจะพิสูจน์ไม่ได้');
    }
    if (!index.all.some(function (room) { return room.pricePerSqmTHB; })) {
      blockers.push('ห้องของ ASHER ยังไม่มีราคา — จุดอ่อนเรื่องราคาต่อ ตร.ม. จะพิสูจน์ไม่ได้');
    }
  }
  if (!context.marketMedianPricePerSqm && competitors.length) {
    blockers.push('ต้องมีราคาห้องคู่แข่งอย่างน้อย 3 ผัง ระบบถึงจะหาค่ากลางราคาต่อ ตร.ม. ได้');
  }
  return blockers;
}

module.exports = {
  analyze,
  roomClass,
  indexAsherRooms,
  LOCKED_EXPLOITABILITY,
  MAX_EXPLOITABILITY,
  SIZE_STANDARD,
  CEILING_STANDARD
};
