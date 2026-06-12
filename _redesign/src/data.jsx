// Mock data scaled to match what's seen in the user's actual app screenshots.
// Driver list, loads, fleet, etc. — modeled after the real entities they showed.

const DRIVERS = [
  { id: "JK", name: "Joshua Kly",     phone: "(224) 480-6765", type: "Company Driver", color: "#a78bfa", status: "active", loads: 6, rti: 5, avg: 0.19, lastLoad: "May 20, 2026" },
  { id: "CB", name: "Charles Best",    phone: "(847) 343-5301", type: "Company Driver", color: "#1ea8f3", status: "active", loads: 5, rti: 4, avg: 0.16, lastLoad: "May 19, 2026" },
  { id: "JS", name: "Jason Smith",     phone: "(779) 537-3141", type: "Company Driver", color: "#f59e0b", status: "active", loads: 4, rti: 2, avg: 0.13, lastLoad: "May 20, 2026" },
  { id: "ZP", name: "Zak Pace",        phone: "(847) 293-6704", type: "Company Driver", color: "#14b8a6", status: "active", loads: 1, rti: 1, avg: 0.03, lastLoad: "May 19, 2026" },
  { id: "RW", name: "Roy Workman",     phone: "(785) 577-9990", type: "Company Driver", color: "#ec4899", status: "active", loads: 0, rti: 0, avg: 0,    lastLoad: "—" },
  { id: "CS", name: "Chad Salerno",    phone: "(602) 317-7631", type: "Company Driver", color: "#a78bfa", status: "active", loads: 0, rti: 0, avg: 0,    lastLoad: "—" },
  { id: "LL", name: "Lee Lara",        phone: "(928) 246-9194", type: "Company Driver", color: "#f59e0b", status: "active", loads: 0, rti: 0, avg: 0,    lastLoad: "—" },
  { id: "JB", name: "John Brittich",   phone: "(262) 321-8765", type: "Company Driver", color: "#22c55e", status: "active", loads: 0, rti: 0, avg: 0,    lastLoad: "—", notes: "CLASS A B C D" },
  { id: "AA", name: "Armando Aranda",  phone: "(262) 818-6030", type: "Company Driver", color: "#1ea8f3", status: "active", loads: 0, rti: 0, avg: 0,    lastLoad: "—" },
  { id: "BC", name: "BROKER COVERED",       phone: "(000) 000-0000", type: "Broker / 3PL",    color: "#22c55e", status: "active", loads: 8, rti: 7, avg: 0.32, lastLoad: "May 20, 2026", broker: true },
  { id: "BN", name: "BROKER NEED TO COVER", phone: "(000) 000-0000", type: "Broker / 3PL",    color: "#ef4444", status: "active", loads: 0, rti: 0, avg: 0,    lastLoad: "—", broker: true },
];

const RAW_LOADS = [
  // Mon May 18
  { pro: 13355, tms: "205187245", pu: "1714694", shipper: "BATORY'S OAKLEY", origin: "CHICAGO, IL",        dest: "WAUKEGAN, IL",    puAppt: "May 18, 6:00 AM",  deAppt: "May 19, 2:00 PM",  driver: "JK", rate: null, rti: true,  status: "ready", dayKey: "MON" },
  { pro: 13469, tms: "205415111", pu: "1715868", shipper: "BATORY'S OAKLEY", origin: "Yard",               dest: "WAUKEGAN, IL",    puAppt: "May 18, 7:00 AM",  deAppt: "May 18, 9:00 AM",  driver: "JS", rate: 509,  rti: true,  status: "ready", dayKey: "MON" },
  { pro: 13373, tms: "205323438", pu: "1714973", shipper: "BATORY STANLEY",  origin: "Yard",               dest: "NEW BERLIN, WI",  puAppt: "May 18, 7:00 AM",  deAppt: "May 18, 11:00 AM", driver: "JK", rate: 681,  rti: true,  status: "ready", dayKey: "MON" },
  { pro: 13476, tms: "205415112", pu: "1715874", shipper: "BATORY'S OAKLEY", origin: "CHICAGO, IL",        dest: "WAUKEGAN, IL",    puAppt: "May 18, 7:00 AM",  deAppt: "May 18, 9:00 AM",  driver: "CB", rate: 509,  rti: true,  status: "ready", dayKey: "MON" },
  { pro: 13505, tms: "31454-26167", pu: "31454-26167", shipper: "BLOOMINGTON SVCS", origin: "ZION, IL",   dest: "Yard",            puAppt: "May 18, 8:00 AM",  deAppt: "May 19, 8:00 AM",  driver: "CB", rate: null, rti: true,  status: "ready", dayKey: "MON" },
  { pro: 13459, tms: "968222",    pu: "968222",  shipper: "QUAD/GRAPHICS",   origin: "SUSSEX, WI",         dest: "CHICAGO, IL",     puAppt: "May 18, 8:00 AM",  deAppt: "May 18, 1:00 PM",  driver: "JK", rate: 550,  rti: true,  status: "ready", dayKey: "MON" },
  { pro: 13506, tms: "36637151",  pu: "36637151", shipper: "ADDRESS",        origin: "OAK CREEK, WI",      dest: "UNIV PARK, IL",   puAppt: "May 18, 8:00 AM",  deAppt: "May 18, 9:30 AM",  driver: "JS", rate: null, rti: true,  status: "ready", dayKey: "MON" },
  { pro: 13364, tms: "205270914", pu: "1715078", shipper: "BATORY'S OAKLEY", origin: "Yard",               dest: "NEW BERLIN, WI",  puAppt: "May 18, 10:00 AM", deAppt: "May 18, 12:00 PM", driver: "JS", rate: 681,  rti: true,  status: "ready", dayKey: "MON" },
  { pro: 13320, tms: "204930341", pu: "1713446", shipper: "BATORY FOODS",    origin: "WILMINGTON, IL",     dest: "MILWAUKEE, WI",   puAppt: "May 18, 10:00 AM", deAppt: "May 18, 12:00 PM", driver: "BC", rate: 821,  rti: true,  status: "ready", dayKey: "MON" },
  // Tue May 19
  { pro: 13477, tms: "205415116", pu: "1715875", shipper: "BATORY'S OAKLEY", origin: "CHICAGO, IL",        dest: "Yard",            puAppt: "May 19, 7:00 AM",  deAppt: "May 20, 10:00 AM", driver: "CB", rate: null, rti: false, status: "open", dayKey: "TUE" },
  { pro: 13517, tms: "TRAILER GP531394 FR-110255", pu: "TRAILER GP531394 FR-110255", shipper: "TRAILER", origin: "CICERO, IL", dest: "NEWTON, IA", puAppt: "May 19, 7:00 AM", deAppt: "May 19, 12:00 PM", driver: "JK", rate: 1500, rti: true,  status: "ready", dayKey: "TUE" },
  { pro: 13505, tms: "31454-26167", pu: "31454-26167", shipper: "BLOOMINGTON", origin: "Yard", dest: "CHICAGO, IL", puAppt: "May 19, 8:00 AM", deAppt: "May 19, 12:00 PM", driver: "CB", rate: 400, rti: true, status: "ready", dayKey: "TUE" },
  { pro: 13460, tms: "205937732", pu: "1717688", shipper: "BATORY'S OAKLEY", origin: "CHICAGO, IL",        dest: "MONROE, WI",      puAppt: "May 19, 8:00 AM",  deAppt: "May 19, 1:00 PM",  driver: "BC", rate: 816,  rti: true,  status: "ready", dayKey: "TUE" },
  { pro: 13484, tms: "206069833", pu: "1719290", shipper: "BATORY FOODS",    origin: "WILMINGTON, IL",     dest: "WINDSOR, WI",     puAppt: "May 19, 8:00 AM",  deAppt: "May 19, 12:00 PM", driver: "BC", rate: 944,  rti: true,  status: "ready", dayKey: "TUE" },
  { pro: 13506, tms: "36637151",  pu: "36637151", shipper: "ADDRESS",        origin: "Yard",               dest: "UNIV PARK, IL",   puAppt: "May 19, 9:30 AM",  deAppt: "May 19, 11:00 AM", driver: "JS", rate: 550,  rti: true,  status: "ready", dayKey: "TUE" },
  { pro: 13388, tms: "205444143", pu: "PO-1256296", shipper: "RYAN SYSTEMS", origin: "CHICAGO, IL",       dest: "MILWAUKEE, WI",   puAppt: "May 19, 10:00 AM", deAppt: "May 19, 1:00 PM",  driver: "CB", rate: 675,  rti: true,  status: "ready", dayKey: "TUE" },
  { pro: 13513, tms: "338298-1",  pu: "338298-1", shipper: "TRD ROOSEVELT",  origin: "ADDISON, IL",        dest: "SHEBOYGAN, WI",   puAppt: "May 19, 11:54 AM", deAppt: "May 19, 1:00 PM",  driver: "ZP", rate: 850,  rti: true,  status: "ready", dayKey: "TUE" },
  // Wed May 20
  { pro: 13478, tms: "205415367", pu: "1715876", shipper: "BATORY OAKLEY",   origin: "CHICAGO, IL",        dest: "Yard",            puAppt: "May 20, 6:00 AM",  deAppt: "May 20, 10:00 AM", driver: "JK", rate: null, rti: false, status: "open", dayKey: "WED" },
  { pro: 13482, tms: "206056770", pu: "1717020", shipper: "BATORY FOODS",    origin: "CHICAGO, IL",        dest: "LIVINGSTON, WI",  puAppt: "May 20, 6:00 AM",  deAppt: "TBD",              driver: "BC", rate: null, rti: false, status: "open", dayKey: "WED" },
  { pro: 13453, tms: "205848925", pu: "1718137", shipper: "BATORY OAKLEY",   origin: "CHICAGO, IL",        dest: "WINDSOR, WI",     puAppt: "May 20, 6:00 AM",  deAppt: "May 20, 12:00 PM", driver: "JS", rate: 904,  rti: false, status: "open", dayKey: "WED" },
  { pro: 13442, tms: "205750032", pu: "1717658", shipper: "BATORY WILMINGTON", origin: "WILMINGTON, IL",   dest: "MILWAUKEE, WI",   puAppt: "May 20, 8:00 AM",  deAppt: "May 20, 12:00 PM", driver: "BC", rate: 826,  rti: false, status: "needs", dayKey: "WED" },
  { pro: 13448, tms: "205791669", pu: "1715679", shipper: "BATORY FOODS",    origin: "WILMINGTON, IL",     dest: "MILWAUKEE, WI",   puAppt: "May 20, 9:00 AM",  deAppt: "May 20, 12:00 PM", driver: "BC", rate: 821,  rti: false, status: "needs", dayKey: "WED" },
  { pro: 13171, tms: "203986634", pu: "1708073", shipper: "BATORY FOODS",    origin: "WILMINGTON, IL",     dest: "NEW BERLIN, WI",  puAppt: "May 20, 10:00 AM", deAppt: "May 20, 2:00 PM",  driver: "BC", rate: 819,  rti: false, status: "open", dayKey: "WED" },
  { pro: 13523, tms: "4349349",   pu: "20260520", shipper: "IPM FOODS",      origin: "JANESVILLE, WI",     dest: "ROMEOVILLE, IL",  puAppt: "May 20, 1:00 PM",  deAppt: "May 21, 8:00 AM",  driver: "JS", rate: null, rti: false, status: "open", dayKey: "WED" },
  // Thu May 21
  { pro: 13510, tms: "205415360", pu: "1715869", shipper: "BATORY OAKLEY",   origin: "CHICAGO, IL",        dest: "Yard",            puAppt: "May 21, 6:00 AM",  deAppt: "May 22, 12:00 AM", driver: null, rate: null, rti: false, status: "unassigned", dayKey: "THU" },
  { pro: 13420, tms: "205601529", pu: "1716843", shipper: "BATORY OAKLEY",   origin: "CHICAGO, IL",        dest: "Yard",            puAppt: "May 21, 6:00 AM",  deAppt: "May 22, 12:00 AM", driver: null, rate: null, rti: false, status: "unassigned", dayKey: "THU" },
  { pro: 13440, tms: "205741237", pu: "1717511", shipper: "BATORY",          origin: "CHICAGO, IL",        dest: "WAUKEGAN, IL",    puAppt: "May 21, 7:00 AM",  deAppt: "May 22, 12:00 AM", driver: null, rate: null, rti: false, status: "unassigned", dayKey: "THU" },
  { pro: 13527, tms: "APPT# 45393-WI", pu: "APPT# 45393-WI", shipper: "BATORY", origin: "CHICAGO, IL",     dest: "WAUKEGAN, IL",    puAppt: "May 21, 12:00 PM", deAppt: "May 21, 2:00 PM",  driver: null, rate: null, rti: false, status: "unassigned", dayKey: "THU" },
];

const FLEET = [
  { type: "Truck", unit: "#009", year: 2012, makeModel: "FREIGHTLINER CASCADIA", plate: "AN04392", dotInsp: "2026-02-26", iftaExp: "2026-12-31", irpExp: "2026-12-31", insurance: "2026-08-21", bobtail: "2027-03-17", driver: "Unassigned", fleetMgr: "Ryne", tollway: "No",  tasks: "2 open",                  repair: null },
  { type: "Truck", unit: "#299", year: 2014, makeModel: "FREIGHTLINER CASCADIA", plate: "P1343771", dotInsp: "2026-02-09", iftaExp: "2027-03-31", irpExp: "2027-03-31", insurance: "2026-08-21", bobtail: "—",         driver: "Unassigned", fleetMgr: "Ryne", tollway: "Yes", tasks: "None",                    repair: 10538.95 },
  { type: "Truck", unit: "#530", year: 2018, makeModel: "VOLVO VNL",             plate: "P1233771", dotInsp: "2026-01-31", iftaExp: "2026-12-31", irpExp: "2027-03-31", insurance: "2026-08-21", bobtail: "—",         driver: "Unassigned", fleetMgr: "Jason", tollway: "Yes", tasks: "2 high · 5 other",        repair: 6015.83 },
  { type: "Truck", unit: "#685", year: 2018, makeModel: "VOLVO VNL",             plate: "P1170810", dotInsp: "—",          iftaExp: "2026-12-31", irpExp: "2027-03-31", insurance: "2026-08-21", bobtail: "—",         driver: "Unassigned", fleetMgr: "Jason", tollway: "Yes", tasks: "2 high · 1 other",        repair: 6466.63 },
  { type: "Truck", unit: "#780", year: 2013, makeModel: "MACK",                  plate: "P1170809", dotInsp: "2026-03-17", iftaExp: "2026-12-31", irpExp: "2027-03-31", insurance: "2026-08-21", bobtail: "—",         driver: "Unassigned", fleetMgr: "Jason", tollway: "Yes", tasks: "1 high · 2 other",        repair: 1784.76 },
  { type: "Truck", unit: "#TBD", year: 2020, makeModel: "KENWORTH T680",         plate: "AKC707",   dotInsp: "2026-03-12", iftaExp: "2026-12-31", irpExp: "2026-12-31", insurance: "2026-08-21", bobtail: "2027-02-27", driver: "Unassigned", fleetMgr: "Ryne",  tollway: "No",  tasks: "None",                    repair: null },
  { type: "Trailer", unit: "#53103",  year: 2021, makeModel: "UTILITY",     plate: "1059202",   dotInsp: "2026-03-01", insurance: "2026-08-21", driver: "—", fleetMgr: "Jason", tollway: "No",  tasks: "3 open", repair: 77.75 },
  { type: "Trailer", unit: "#53105",  year: 2021, makeModel: "UTILITY",     plate: "778-AC-525", dotInsp: "2026-04-06", insurance: "2026-08-21", driver: "—", fleetMgr: "Jason", tollway: "No",  tasks: "2 open", repair: null },
  { type: "Trailer", unit: "#531375", year: 2015, makeModel: "HYUNDAI",     plate: "539670ST",  dotInsp: "2025-08-01", insurance: "2026-08-21", driver: "—", fleetMgr: "Jason", tollway: "Yes", tasks: "1 high · 4 other", repair: 428.20 },
  { type: "Trailer", unit: "#531386", year: 2015, makeModel: "GREAT DANE",  plate: "532050ST",  dotInsp: "2024-11-01", insurance: "2026-08-21", driver: "—", fleetMgr: "Jason", tollway: "Yes", tasks: "1 high · 3 other", repair: 1008.75 },
  { type: "Trailer", unit: "#531388", year: 2015, makeModel: "GREAT DANE",  plate: "532048ST",  dotInsp: "2026-05-06", insurance: "2026-08-21", driver: "—", fleetMgr: "Jason", tollway: "Yes", tasks: "2 high · 2 other", repair: 2786.95 },
  { type: "Trailer", unit: "#531389", year: 2015, makeModel: "GREAT DANE",  plate: "532047ST",  dotInsp: "2025-09-01", insurance: "2026-08-21", driver: "—", fleetMgr: "Jason", tollway: "Yes", tasks: "None", repair: 3002.76 },
  { type: "Trailer", unit: "#531394", year: 2015, makeModel: "GREAT DANE",  plate: "532104ST",  dotInsp: "2025-10-01", insurance: "2026-08-21", driver: "—", fleetMgr: "Jason", tollway: "Yes", tasks: "1 high · 2 other", repair: 1393.36 },
  { type: "Trailer", unit: "#5384",   year: 2019, makeModel: "GREAT DANE",  plate: "778-AC-522", dotInsp: "2026-03-01", insurance: "2026-08-21", driver: "—", fleetMgr: "Jason", tollway: "Yes", tasks: "1 high · 2 other", repair: 202.13 },
  { type: "Trailer", unit: "#5389",   year: 2019, makeModel: "GREAT DANE",  plate: "778-AC-523", dotInsp: "—",          insurance: "2026-08-21", driver: "—", fleetMgr: "Jason", tollway: "No",  tasks: "1 high", repair: null },
  { type: "Trailer", unit: "#5922",   year: 2019, makeModel: "GREAT DANE",  plate: "1059204",   dotInsp: "2025-06-01", insurance: "2026-08-21", driver: "—", fleetMgr: "Jason", tollway: "No",  tasks: "1 open", repair: 263.46 },
];

const MAINTENANCE = [
  { task: "DOT Inspection",     desc: "Annual DOT inspection required.",         eq: "#531386", due: "2025-11-01", priority: "High", assignee: null,   status: "overdue" },
  { task: "DOT Inspection",     desc: "Annual DOT inspection required.",         eq: "#685",    due: "2026-03-31", priority: "High", assignee: null,   status: "upcoming" },
  { task: "DOT Inspection",     desc: "Annual DOT inspection required.",         eq: "#5389",   due: "2026-03-31", priority: "High", assignee: null,   status: "upcoming" },
  { task: "Landing gear",       desc: "Lube landing gear hard to rotate.",       eq: "#531386", due: "2026-04-25", priority: "Med",  assignee: "Jason",status: "upcoming" },
  { task: "airbag",             desc: "Left rear axle airbag needs replacement.",eq: "#5384",   due: "2026-04-25", priority: "High", assignee: null,   status: "upcoming" },
  { task: "gladhand",           desc: "Emergency gladhand loose and noisy.",     eq: "#53105",  due: "2026-04-25", priority: "Med",  assignee: null,   status: "upcoming" },
  { task: "crossmember",        desc: "Bent crossmember by the front drive.",    eq: "#531388", due: "2026-04-30", priority: "High", assignee: null,   status: "upcoming" },
  { task: "doors",              desc: "Door seals need to be replaced soon.",    eq: "#531386", due: "2026-04-30", priority: "Med",  assignee: null,   status: "upcoming" },
  { task: "alignment",          desc: "Needs alignment, tracks to the left.",    eq: "#5922",   due: "2026-04-30", priority: "Med",  assignee: null,   status: "upcoming" },
  { task: "electrical",         desc: "Dash lights go bright and can't be dim.", eq: "#780",    due: "2026-04-30", priority: "Med",  assignee: null,   status: "upcoming" },
  { task: "alignment",          desc: "Needs alignment, tracks to the right.",   eq: "#531388", due: "2026-04-30", priority: "Med",  assignee: null,   status: "upcoming" },
  { task: "registration paper", desc: "Needs new registration paper from state.",eq: "#531388", due: "2026-04-30", priority: "High", assignee: null,   status: "upcoming" },
  { task: "Swap out",           desc: "Trailer repairs are too costly, cheaper.",eq: "#531375", due: "2026-04-30", priority: "Med",  assignee: "Jason",status: "upcoming" },
  { task: "2 tires",            desc: "2 left rear axle tires have 2 low spots.",eq: "#531375", due: "2026-04-30", priority: "High", assignee: "Jason",status: "upcoming" },
  { task: "phase 2",            desc: "6 brake drums, 6 brake shoes.",           eq: "#530",    due: "2026-04-30", priority: "Med",  assignee: "Jason",status: "upcoming" },
  { task: "leaking",            desc: "Water leaking around the roof solar.",    eq: "#531394", due: "2026-04-30", priority: "High", assignee: null,   status: "upcoming" },
  { task: "front panel",        desc: "Needs front panel replaced.",             eq: "#531375", due: "2026-05-01", priority: "Med",  assignee: null,   status: "upcoming" },
  { task: "phase 3",            desc: "All 4 airbags dry rotted and in need.",   eq: "#530",    due: "2026-05-09", priority: "Med",  assignee: "Jason",status: "upcoming" },
  { task: "Fittings and hoses", desc: "All brake fittings to chambers.",         eq: "#009",    due: "2026-05-16", priority: "Med",  assignee: "Jason",status: "upcoming" },
  { task: "Transmission",       desc: "Check transmission message popup.",       eq: "#530",    due: "2026-05-30", priority: "High", assignee: "Jason",status: "upcoming" },
  { task: "air tank",           desc: "Air tank rusted out, will cause air leak.",eq: "#531394",due: "2026-05-30", priority: "Low",  assignee: null,   status: "upcoming" },
  { task: "brake chambers",     desc: "Needs 2 brake chambers replaced.",        eq: "#531394", due: "2026-05-30", priority: "Low",  assignee: null,   status: "upcoming" },
];

const INTAKE_ACTIVE = [
  { source: "Ivan Cartage",  subject: "Tender TMS ID 206189379: CHICAGO, IL(06/01) to WAUKEGAN, IL by BATORY FOODS",   age: "6m ago",  assignee: "Dennis", body: "This email was sent from an automated source. Please do not reply to this message as all replies are automatically deleted. BATORY FOODS has tendered TMS ID 206189379 to this carrier...", isNew: true },
  { source: "Ivan Cartage",  subject: "Tender TMS ID 205415366: CHICAGO, IL(05/28) to WAUKEGAN, IL by BATORY FOODS",   age: "7m ago",  assignee: "Dennis", body: "This email was sent from an automated source. Please do not reply to this message as all replies are automatically deleted. BATORY FOODS has tendered TMS ID 205415366 to this carrier...", isNew: true },
  { source: "Ivan Cartage",  subject: "Tender TMS ID 206189377: CHICAGO, IL(05/29) to WAUKEGAN, IL by BATORY FOODS",   age: "12m ago", assignee: "Dennis", body: "This email was sent from an automated source. Please do not reply to this message as all replies are automatically deleted. BATORY FOODS has tendered TMS ID 206189377 to this carrier...", isNew: true },
  { source: "Ivan Cartage",  subject: "Fwd: aurora> waukgan",                                                          age: "55m ago", assignee: "Dennis", body: "Ruben Vargas •Main 847-450-0899×1004• •Direct: 224-369-4163• •1193 E Higgins Rd• •Elk Grove Village IL 60007• www.bcatcorp.com — Forwarded message —", isNew: true },
];

const INTAKE_HISTORY = [
  { when: "May 20, 4:21 PM",  source: "Ivan Cartage",  subject: "Tender TMS ID 206189379: CHICA...",  thread: "USLACKBOT", assignee: "Dennis", status: "new",      link: true },
  { when: "May 20, 4:21 PM",  source: "Ivan Cartage",  subject: "Tender TMS ID 205415366: CHICA...",  thread: "USLACKBOT", assignee: "Dennis", status: "new",      link: true },
  { when: "May 20, 4:15 PM",  source: "Ivan Cartage",  subject: "Tender TMS ID 206189377: CHICA...",  thread: "USLACKBOT", assignee: "Dennis", status: "new",      link: true },
  { when: "May 20, 3:32 PM",  source: "Ivan Cartage",  subject: "Fwd: aurora> waukgan",               thread: "USLACKBOT", assignee: "Dennis", status: "new",      link: true },
  { when: "May 20, 2:52 PM",  source: "Ivan Cartage",  subject: "Fwd: PAUL'S LOAD R48407 — SHIPS...", thread: "USLACKBOT", assignee: "Dennis", status: "built",    link: "13527" },
  { when: "May 20, 10:07 AM", source: "BCAT Logistics",subject: "new load test chicago to mexico",    thread: "UHVFTVD0S", assignee: "Dennis", status: "done",     link: false },
  { when: "May 20, 10:06 AM", source: "Ivan Cartage",  subject: "NEW LOAD TEST CHICAGO TO MEX...",    thread: "UHVFTVD0S", assignee: "Dennis", status: "archived", link: false },
  { when: "May 20, 9:55 AM",  source: "Ivan Cartage",  subject: "13442 RC.pdf",                       thread: "UHVFTVD0S", assignee: "Dennis", status: "built",    link: true },
  { when: "May 20, 9:16 AM",  source: "Ivan Cartage",  subject: "LOAD CHICAGO TO MICHIGAN",           thread: "UHVFTVD0S", assignee: "Dennis", status: "built",    link: true },
  { when: "May 20, 8:51 AM",  source: "Ivan Cartage",  subject: "LOAD CHICAGO TO MICHIGAN",           thread: "UHVFTVD0S", assignee: "Dennis", status: "built",    link: true },
  { when: "May 19, 4:27 PM",  source: "Ivan Cartage",  subject: "(no subject)",                       thread: "Ruben Vargas <ruben@bcatcorp.com>", assignee: "Dennis", status: null, link: false },
  { when: "May 19, 4:27 PM",  source: "Ivan Cartage",  subject: "(no subject) (1 attach)",            thread: "Ruben Vargas <ruben@bcatcorp.com>", assignee: "Dennis", status: null, link: false },
  { when: "May 19, 12:25 PM", source: "BCAT Logistics",subject: "Fwd: [External] Re: GPI NEWTON",     thread: "Ryne Bandolik <Ryne@bcatcorp.com>", assignee: "Arcie",  status: null, link: false },
  { when: "May 19, 12:24 PM", source: "BCAT Logistics",subject: "Fwd: [External] Re: GPI NEWTON",     thread: "Ryne Bandolik <Ryne@bcatcorp.com>", assignee: "Arcie",  status: null, link: false },
];

// Driver schedules (Wed May 20)
const SCHEDULES = [
  { driver: "BROKER COVERED", type: "BROKER", id: "BC", count: 4, loads: [
    { n: 1, origin: "BATORY FOODS, CHICAGO, IL",         dest: "RURAL ROUTE 1, INC, LIVINGSTON, WI", pu: "6:00 AM",  de: "TBD",      proPu: "13482", pkg: "1717020" },
    { n: 2, origin: "BATORY WILMINGTON, WILMINGTON, IL", dest: "DREAMPAK, MILWAUKEE, WI",            pu: "8:00 AM",  de: "TBD",      proPu: "13442", pkg: "1717658" },
    { n: 3, origin: "BATORY FOODS, WILMINGTON, IL",      dest: "PVI WEST MILWAUKEE, MILWAUKEE, WI",  pu: "9:00 AM",  de: "TBD",      proPu: "13448", pkg: "1715679" },
    { n: 4, origin: "BATORY FOODS, WILMINGTON, IL",      dest: "DREAMPAK L.L.C, NEW BERLIN WI",      pu: "10:00 AM", de: "2:00 PM",  proPu: "13171", pkg: "1708073" },
  ]},
  { driver: "Joshua Kly", type: "Driver", id: "JK", count: 1, loads: [
    { n: 1, origin: "BATORY OAKLEY, CHICAGO, IL", dest: "EAGLE FOODS, WAUKEGAN, IL", pu: "6:00 AM", de: "12:00 AM", proPu: "13478", pkg: "1715876" },
  ]},
  { driver: "Jason Smith", type: "Driver", id: "JS", count: 2, loads: [
    { n: 1, origin: "BATORY OAKLEY, CHICAGO, IL", dest: "BELL LABORATORIES, WINDSOR, WI", pu: "6:00 AM", de: "FCFS", proPu: "13453", pkg: "1718137" },
    { n: 2, origin: "IPM FOODS — NATURPAK AMBER RUTHERFORD, JANESVILLE, WI", dest: "ROMEOVILLE, IL", pu: "1:00 PM", de: "8:00 AM next", proPu: "13523", pkg: "20260520" },
  ]},
];

const AUDIT = [
  { when: "Wed, May 20, 2026, 12:37 PM", action: "Update", entity: "Load",   id: "929b3b91...", user: "dennis@bcatcorp.com", fields: 2 },
  { when: "Mon, May 18, 2026, 3:41 PM",  action: "Create", entity: "Load",   id: "83267f58...", user: "ryne@bcatcorp.com",   fields: 1 },
  { when: "Wed, May 20, 2026, 9:33 AM",  action: "Update", entity: "Load",   id: "f9845960...", user: "ryne@bcatcorp.com",   fields: 1 },
  { when: "Wed, May 20, 2026, 12:26 PM", action: "Update", entity: "Load",   id: "0a62437e...", user: "dennis@bcatcorp.com", fields: 2 },
  { when: "Wed, May 20, 2026, 9:46 AM",  action: "Update", entity: "Load",   id: "f9845960...", user: "ryne@bcatcorp.com",   fields: 1 },
  { when: "Wed, May 20, 2026, 12:36 PM", action: "Update", entity: "Load",   id: "f9845960...", user: "dennis@bcatcorp.com", fields: 2 },
  { when: "Tue, May 19, 2026, 2:45 PM",  action: "Create", entity: "Load",   id: "e2decec9...", user: "dennis@bcatcorp.com", fields: 1 },
  { when: "Tue, May 19, 2026, 12:01 PM", action: "Update", entity: "Load",   id: "1c470afb...", user: "dennis@bcatcorp.com", fields: 2 },
  { when: "Tue, May 19, 2026, 9:55 PM",  action: "Update", entity: "Load",   id: "f9845960...", user: "ryne@bcatcorp.com",   fields: 2 },
  { when: "Tue, May 19, 2026, 9:53 PM",  action: "Update", entity: "Load",   id: "421e6735...", user: "ryne@bcatcorp.com",   fields: 2 },
  { when: "Tue, May 19, 2026, 3:32 PM",  action: "Update", entity: "Load",   id: "f9845960...", user: "ryne@bcatcorp.com",   fields: 5 },
  { when: "Mon, May 18, 2026, 11:27 AM", action: "Update", entity: "Driver", id: "7a1a5172...", user: "ryne@bcatcorp.com",   fields: 2 },
  { when: "Tue, May 19, 2026, 4:13 PM",  action: "Update", entity: "Load",   id: "4b0507a6...", user: "ryne@bcatcorp.com",   fields: 4 },
  { when: "Tue, May 19, 2026, 2:53 PM",  action: "Create", entity: "Load",   id: "e41dbfb3...", user: "dennis@bcatcorp.com", fields: 1 },
  { when: "Mon, May 18, 2026, 1:53 PM",  action: "Delete", entity: "Driver", id: "7a1a5172...", user: "ryne@bcatcorp.com",   fields: 1 },
  { when: "Wed, May 20, 2026, 11:46 AM", action: "Update", entity: "Load",   id: "2dfcb8b1...", user: "dennis@bcatcorp.com", fields: 2 },
  { when: "Tue, May 19, 2026, 9:53 PM",  action: "Update", entity: "Load",   id: "421e6735...", user: "ryne@bcatcorp.com",   fields: 2 },
  { when: "Wed, May 20, 2026, 12:34 PM", action: "Update", entity: "Load",   id: "421e6735...", user: "dennis@bcatcorp.com", fields: 3 },
  { when: "Tue, May 19, 2026, 3:44 PM",  action: "Update", entity: "Load",   id: "f9845960...", user: "ryne@bcatcorp.com",   fields: 1 },
  { when: "Tue, May 19, 2026, 9:53 PM",  action: "Update", entity: "Load",   id: "421e6735...", user: "ryne@bcatcorp.com",   fields: 2 },
];

// Charts data
const LOADS_BY_DAY = [
  { d: "May 1",  v: 0 }, { d: "May 3", v: 0 }, { d: "May 5", v: 0 }, { d: "May 7", v: 0 }, { d: "May 9", v: 0 },
  { d: "May 11", v: 0 }, { d: "May 13", v: 1 }, { d: "May 15", v: 2 }, { d: "May 17", v: 5 }, { d: "May 18", v: 9 },
  { d: "May 19", v: 7 }, { d: "May 20", v: 8 }, { d: "May 21", v: 6 }, { d: "May 23", v: 0 }, { d: "May 25", v: 4 },
  { d: "May 27", v: 5 }, { d: "May 29", v: 2 }, { d: "May 31", v: 1 },
];

// Fuel weekly data
const FUEL_WEEKLY = [
  { week: "4/19-4/25", "#009": 1804.95, "#299": 1747.05, "#530": 1035.63, "#685": 909.74,  "#780": 1009.21 },
  { week: "4/26-5/2",  "#009": 1318.62, "#299": 1264.32, "#530": 1557.30, "#685": 986.27,  "#780": 1447.73 },
  { week: "5/3-5/9",   "#009": 1858.34, "#299": 1347.21, "#530": 1407.59, "#685": 1098.83, "#780": 1200.53 },
  { week: "5/10-5/16", "#009": 1958.80, "#299": 2251.56, "#530": 2050.99, "#685": 2454.36, "#780": 1284.88 },
  { week: "5/17-5/23", "#009": 1690.25, "#299": 1431.16, "#530": 712.80,  "#685": 1195.84, "#780": 6162.00 },
];

const FUEL_TRUCKS = ["#009", "#299", "#530", "#685", "#780"];
const FUEL_COLORS = { "#009": "#1ea8f3", "#299": "#f59e0b", "#530": "#22c55e", "#685": "#a78bfa", "#780": "#ef4444" };

// Calendar view rows (calendar page mock)
const CAL_DAYS = ["MON", "TUE", "WED", "THU", "FRI"];

window.DRIVERS = DRIVERS;
window.RAW_LOADS = RAW_LOADS;
window.FLEET = FLEET;
window.MAINTENANCE = MAINTENANCE;
window.INTAKE_ACTIVE = INTAKE_ACTIVE;
window.INTAKE_HISTORY = INTAKE_HISTORY;
window.SCHEDULES = SCHEDULES;
window.AUDIT = AUDIT;
window.LOADS_BY_DAY = LOADS_BY_DAY;
window.FUEL_WEEKLY = FUEL_WEEKLY;
window.FUEL_TRUCKS = FUEL_TRUCKS;
window.FUEL_COLORS = FUEL_COLORS;
window.CAL_DAYS = CAL_DAYS;

// Helpers
window.driverById = (id) => DRIVERS.find(d => d.id === id);
window.fmtMoney = (n) => n == null ? "—" : "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
window.fmtMoney0 = (n) => n == null ? "—" : "$" + Math.round(n).toLocaleString("en-US");
