/**
 * Code.gs — Device Management Dashboard backend (complete, single file).
 *
 * What this file does
 *  - Serves the dashboard page (doGet / include) to authorised administrators only.
 *  - Exposes ONE function to the page, api(method, args), which reads and writes your Google Sheet.
 *  - Validates every change on the server, writes under a lock, never deletes records.
 *
 * Files this project ALSO needs (they are the dashboard itself, not backend code):
 *    Index.html, Styles.html, Client.html   and the appsscript.json manifest.
 *
 * Access control (set it up exactly as described in the notes that came with this file):
 *  - Deploy the web app as "Execute as: User accessing the web app".
 *  - Add the administrators' emails to the script property ADMIN_EMAILS (comma-separated).
 *    If that property is missing or empty, NOBODY is allowed (fails closed).
 */

/* ============================== 1. CONFIGURATION ============================== */

/** Your spreadsheet. The SPREADSHEET_ID script property, if set, overrides this value. The ID is not a secret:
 *  access to the data is controlled by the spreadsheet's sharing settings plus the ADMIN_EMAILS list. */
const DEFAULT_SPREADSHEET_ID = '1CDxmi4h40719VwON7wi1dSBHQpVMn7Dq-8ZbYR3N4n8';
const ADMIN_PROPERTY = 'ADMIN_EMAILS';
const LOCK_WAIT_MS = 20000;
const MAX_REQUEST_CHARS = 200000;
const MAX_FIELD_CHARS = 2000;
const INCLUDABLE_FILES = ['Styles', 'Client'];

const TABLES = {
  employees: {
    tab: 'Employees', idField: 'Employee_ID',
    headers: ['Employee_ID', 'Employee_Name', 'Work_Email', 'Department', 'Designation', 'Manager_Name', 'Joining_Date', 'Employment_Status', 'Last_Working_Date', 'Notes']
  },
  devices: {
    tab: 'Devices', idField: 'Device_ID',
    headers: ['Device_ID', 'Asset_Tag', 'Device_Type', 'Brand', 'Model', 'Serial_Number', 'Device_Ownership_Type', 'Rental_Vendor', 'Rental_Start_Date', 'Rental_End_Date', 'Device_Condition', 'Current_Status', 'Notes']
  },
  assignments: {
    tab: 'Assignments', idField: 'Assignment_ID',
    headers: ['Assignment_ID', 'Employee_ID', 'Device_ID', 'Issue_Date', 'Issued_By', 'Condition_At_Issue', 'Accessories_Issued', 'Assignment_Status', 'Return_Date', 'Return_ID', 'Remarks']
  },
  returns: {
    tab: 'Returns', idField: 'Return_ID',
    headers: ['Return_ID', 'Assignment_ID', 'Device_ID', 'Employee_ID', 'Physical_Return_Date', 'Condition_At_Return', 'Accessories_Returned', 'Missing_Items', 'Received_By', 'Remarks']
  }
};
const LISTS_TAB = 'Lists';
const LISTS_HEADERS = ['List_Name', 'Value'];

/** Dropdown values used when the Lists tab does not contain a list yet. */
const DEFAULT_LISTS = {
  'Departments': ['Engineering', 'Design', 'Sales', 'Marketing', 'Finance', 'HR', 'Operations', 'Support', 'IT'],
  'Designations': ['Engineering Director', 'Engineering Manager', 'Senior Software Engineer', 'Software Engineer', 'QA Engineer', 'DevOps Engineer',
    'Product Designer', 'Account Executive', 'Sales Manager', 'HR Business Partner', 'Financial Analyst', 'Accounts Executive',
    'Content Strategist', 'Growth Marketer', 'Operations Coordinator', 'Support Specialist', 'IT Support Engineer'],
  'Device Types': ['Laptop', 'Desktop', 'Monitor', 'Headphones', 'Keyboard', 'Mouse', 'Charger / Adapter', 'Mobile Phone', 'Tablet', 'Docking Station', 'Webcam', 'Other'],
  'Brands': ['Apple', 'Anker', 'Dell', 'HP', 'Jabra', 'Lenovo', 'LG', 'Logitech', 'Microsoft', 'Samsung', 'Sony', 'Other'],
  'Device Conditions': ['New', 'Good', 'Fair', 'Damaged'],
  'Device Statuses': ['Available', 'Assigned', 'Under Repair', 'Retired', 'Lost'],
  'Ownership Types': ['Owned', 'Rented'],
  'Employment Statuses': ['Active', 'Notice Period', 'Exited'],
  'Assignment Statuses': ['Active', 'Returned', 'Cancelled']
};
/** Lists whose values drive workflow rules: they cannot be edited from the dashboard. */
const LOCKED_LISTS = ['Device Statuses', 'Ownership Types', 'Employment Statuses', 'Assignment Statuses'];
const PROTECTED_VALUES = { 'Device Conditions': ['New', 'Good', 'Fair', 'Damaged'] };

const DEVICE_STATUS_RETURN_REPAIR = 'Under Repair';
const OPEN_STATUS = 'Active'; // an assignment is "open" while it is Active

/* ============================ 2. PAGE + ACCESS CONTROL ============================ */

function currentEmail_() {
  let email = '';
  try { email = Session.getActiveUser().getEmail(); } catch (e) { email = ''; }
  return String(email || '').trim().toLowerCase();
}

function adminList_() {
  const raw = PropertiesService.getScriptProperties().getProperty(ADMIN_PROPERTY) || '';
  return raw.split(/[,;\s]+/).map(function (s) { return s.trim().toLowerCase(); }).filter(function (s) { return s; });
}

function isAdmin_(email) {
  return !!email && adminList_().indexOf(email) !== -1;
}

function escapeHtml_(s) {
  return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function effectiveEmail_() {
  let email = '';
  try { email = Session.getEffectiveUser().getEmail(); } catch (e) { email = ''; }
  return String(email || '').trim().toLowerCase();
}

function page_(title, bodyHtml) {
  return HtmlService.createHtmlOutput('<div style="font-family:Arial,sans-serif;max-width:560px;margin:12vh auto;padding:0 20px;color:#18212b;line-height:1.5">' + bodyHtml + '</div>').setTitle(title);
}

function deniedPage_(email) {
  if (!email) {
    return page_('Access denied',
      '<h2>Access denied</h2><p>Your Google account email could not be identified, so access cannot be checked.</p>' +
      '<p>Make sure you are signed in to Google and have approved the permission prompt. The owner must deploy the web app with <strong>Execute as: User accessing the web app</strong>. ' +
      'Open this address with <code>?diag=1</code> at the end to run the identity check.</p>');
  }
  return page_('Access denied',
    '<h2>Access denied</h2><p>The account <strong>' + escapeHtml_(email) + '</strong> is not an authorised administrator of this dashboard.</p>' +
    '<p>Ask the dashboard owner to add your email to the administrator list, then reload this page.</p>');
}

/**
 * Identity check page: open the web app URL with ?diag=1 at the end.
 * It shows only the visitor's OWN identity and yes/no results. No spreadsheet data, no admin list.
 */
function diagPage_() {
  const active = currentEmail_(), effective = effectiveEmail_();
  const identified = !!active;
  const runsAsVisitor = identified && active === effective;
  const onList = isAdmin_(active);
  function row(label, good, detail) {
    return '<tr><td style="padding:6px 12px 6px 0">' + label + '</td><td style="padding:6px 0"><strong style="color:' + (good ? '#1f7a57' : '#b3362f') + '">' + (good ? 'YES' : 'NO') + '</strong> ' + detail + '</td></tr>';
  }
  const html = '<h2>Identity check</h2><table style="border-collapse:collapse">' +
    row('Your email could be identified', identified, identified ? '(' + escapeHtml_(active) + ')' : '(deploy as "User accessing the web app" and approve the permission prompt)') +
    row('The app runs as you, not as the owner', runsAsVisitor, runsAsVisitor ? '' : '(deployment is set to "Execute as: Me". Redeploy as "User accessing the web app")') +
    row('Administrator list is configured', adminList_().length > 0, adminList_().length ? '' : '(set the ADMIN_EMAILS script property)') +
    row('Your account is on the administrator list', onList, '') + '</table>' +
    '<p style="margin-top:16px">' + (identified && runsAsVisitor && onList ? 'Everything is in order. Open the address without <code>?diag=1</code> to use the dashboard.' : 'Fix the items marked NO, then reload this page.') + '</p>';
  return page_('Identity check', html);
}

/** Web app entry point. Nothing from the spreadsheet is sent before the admin check passes. */
function doGet(e) {
  if (e && e.parameter && e.parameter.diag === '1') return diagPage_();
  const email = currentEmail_();
  if (!isAdmin_(email)) return deniedPage_(email);
  try {
    return HtmlService.createTemplateFromFile('Index').evaluate()
      .setTitle('Device Desk')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  } catch (err) {
    console.error(String(err && err.message));
    return page_('Dashboard files missing',
      '<h2>Dashboard files missing</h2><p>The page could not be built. The Apps Script project must contain the HTML files <strong>Index</strong>, <strong>Styles</strong> and <strong>Client</strong>.</p>');
  }
}

/** Used by Index.html: <?!= include('Styles') ?> and <?!= include('Client') ?>. Only these two files can be included. */
function include(name) {
  if (INCLUDABLE_FILES.indexOf(name) === -1) throw new Error('Unknown file.');
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/* ============================ 3. SMALL HELPERS ============================ */

const Dates_ = {
  fmt: function (d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); },
  parse: function (iso) { const p = iso.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); },
  today: function () { return Dates_.fmt(new Date()); },
  isValid: function (iso) { return typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(iso) && Dates_.fmt(Dates_.parse(iso)) === iso; }
};

function ruleError_(message, fields) {
  const e = new Error(message);
  e.name = 'RuleError';
  e.fields = fields || {};
  return e;
}
function fail_rule_(errs, msg) { throw ruleError_(msg || 'Please fix the highlighted fields.', errs); }
function has_(v) { return v !== null && v !== undefined && String(v).trim() !== ''; }
function norm_(v) { return String(v === null || v === undefined ? '' : v).trim().toLowerCase(); }
function isEmpty_(o) { return Object.keys(o).length === 0; }
function clone_(o) { return o === undefined ? undefined : JSON.parse(JSON.stringify(o)); }
function pad_(n, w) { return String(n).padStart(w, '0'); }

/** Copies only the allowed fields, as trimmed text, and rejects anything that is not plain text/number. */
function cleanInput_(data, fields) {
  if (!data || typeof data !== 'object' || Object.prototype.toString.call(data) === '[object Array]') throw ruleError_('Invalid data was sent.');
  const out = {}, errs = {};
  fields.forEach(function (f) {
    let v = data[f];
    if (v === undefined || v === null) { out[f] = ''; return; }
    if (typeof v === 'object') { errs[f] = 'Invalid value.'; return; }
    v = String(v).trim();
    if (v.length > MAX_FIELD_CHARS) { errs[f] = 'Value is too long (maximum ' + MAX_FIELD_CHARS + ' characters).'; return; }
    out[f] = v;
  });
  if (!isEmpty_(errs)) fail_rule_(errs);
  return out;
}

function nextId_(prefix, width, items, field) {
  let max = 0;
  items.forEach(function (i) {
    const v = String(i[field]);
    const m = v.match(/(\d+)$/);
    if (m && v.indexOf(prefix) === 0) max = Math.max(max, parseInt(m[1], 10));
  });
  return prefix + pad_(max + 1, width);
}

function indexState_(s) {
  const ix = { emp: {}, dev: {}, asg: {}, ret: {}, openByDevice: {}, retByAsg: {} };
  s.employees.forEach(function (e) { ix.emp[e.Employee_ID] = e; });
  s.devices.forEach(function (d) { ix.dev[d.Device_ID] = d; });
  s.assignments.forEach(function (a) {
    ix.asg[a.Assignment_ID] = a;
    if (a.Assignment_Status === OPEN_STATUS) ix.openByDevice[a.Device_ID] = a;
  });
  s.returns.forEach(function (r) {
    ix.ret[r.Return_ID] = r;
    (ix.retByAsg[r.Assignment_ID] = ix.retByAsg[r.Assignment_ID] || []).push(r);
  });
  return ix;
}

/* ============================ 4. VALIDATION ============================ */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function vRequired_(errors, data, field, label) {
  if (!has_(data[field])) errors[field] = label + ' is required.';
  return has_(data[field]);
}
function vInList_(errors, data, field, label, list) {
  if (has_(data[field]) && list && list.indexOf(data[field]) === -1) errors[field] = label + ' must be one of the available options.';
}
function vDate_(errors, data, field, label, required) {
  if (!has_(data[field])) { if (required) errors[field] = label + ' is required.'; return false; }
  if (!Dates_.isValid(data[field])) { errors[field] = 'Enter a valid date for ' + label.toLowerCase() + '.'; return false; }
  return true;
}

/** ctx: { devices, lists, editingId, hasOpenAssignment } */
function validateDevice_(d, ctx) {
  const e = {}, lists = ctx.lists;
  const others = ctx.devices.filter(function (x) { return x.Device_ID !== ctx.editingId; });
  if (vRequired_(e, d, 'Device_ID', 'Device ID') && others.some(function (x) { return norm_(x.Device_ID) === norm_(d.Device_ID); })) e.Device_ID = 'Device ID ' + d.Device_ID + ' already exists.';
  if (vRequired_(e, d, 'Asset_Tag', 'Asset tag') && others.some(function (x) { return norm_(x.Asset_Tag) === norm_(d.Asset_Tag); })) e.Asset_Tag = 'Asset tag ' + d.Asset_Tag + ' is already used by another device.';
  if (has_(d.Serial_Number) && others.some(function (x) { return norm_(x.Serial_Number) === norm_(d.Serial_Number); })) e.Serial_Number = 'Serial number ' + d.Serial_Number + ' is already registered.';
  vRequired_(e, d, 'Device_Type', 'Device type'); vInList_(e, d, 'Device_Type', 'Device type', lists['Device Types']);
  vRequired_(e, d, 'Brand', 'Brand');
  vRequired_(e, d, 'Model', 'Model');
  vRequired_(e, d, 'Device_Ownership_Type', 'Ownership type'); vInList_(e, d, 'Device_Ownership_Type', 'Ownership type', lists['Ownership Types']);
  vRequired_(e, d, 'Device_Condition', 'Condition'); vInList_(e, d, 'Device_Condition', 'Condition', lists['Device Conditions']);
  vRequired_(e, d, 'Current_Status', 'Status'); vInList_(e, d, 'Current_Status', 'Status', lists['Device Statuses']);
  if (d.Device_Ownership_Type === 'Rented') {
    vRequired_(e, d, 'Rental_Vendor', 'Rental vendor');
    const s = vDate_(e, d, 'Rental_Start_Date', 'Rental start date', false);
    const en = vDate_(e, d, 'Rental_End_Date', 'Rental end date', false);
    if (s && en && d.Rental_End_Date < d.Rental_Start_Date) e.Rental_End_Date = 'Rental end date cannot be before the start date.';
  }
  if (!e.Current_Status) {
    if (ctx.editingId) {
      if (ctx.hasOpenAssignment && d.Current_Status !== 'Assigned') e.Current_Status = 'This device is currently allotted. Process its return before changing the status.';
      else if (!ctx.hasOpenAssignment && d.Current_Status === 'Assigned') e.Current_Status = 'Use Device Allotment to assign a device. Status cannot be set to Assigned here.';
    } else if (d.Current_Status === 'Assigned') {
      e.Current_Status = 'New devices cannot start as Assigned. Save as Available, then use Device Allotment.';
    }
  }
  return e;
}

/** ctx: { employees, lists, editingId } */
function validateEmployee_(d, ctx) {
  const e = {}, lists = ctx.lists;
  const others = ctx.employees.filter(function (x) { return x.Employee_ID !== ctx.editingId; });
  if (vRequired_(e, d, 'Employee_ID', 'Employee ID') && others.some(function (x) { return norm_(x.Employee_ID) === norm_(d.Employee_ID); })) e.Employee_ID = 'Employee ID ' + d.Employee_ID + ' already exists.';
  vRequired_(e, d, 'Employee_Name', 'Employee name');
  if (vRequired_(e, d, 'Work_Email', 'Work email')) {
    if (!EMAIL_RE.test(d.Work_Email)) e.Work_Email = 'Enter a valid email address.';
    else if (others.some(function (x) { return norm_(x.Work_Email) === norm_(d.Work_Email); })) e.Work_Email = 'Another employee already uses this email.';
  }
  vRequired_(e, d, 'Department', 'Department');
  vRequired_(e, d, 'Designation', 'Designation');
  const jd = vDate_(e, d, 'Joining_Date', 'Joining date', true);
  vRequired_(e, d, 'Employment_Status', 'Employment status'); vInList_(e, d, 'Employment_Status', 'Employment status', lists['Employment Statuses']);
  const needsLwd = d.Employment_Status === 'Notice Period' || d.Employment_Status === 'Exited';
  const lw = vDate_(e, d, 'Last_Working_Date', 'Last working date', needsLwd);
  if (jd && lw && d.Last_Working_Date < d.Joining_Date) e.Last_Working_Date = 'Last working date cannot be before the joining date.';
  return e;
}

/** ctx: { employee, device, hasOpenAssignmentOnDevice, lists } */
function validateAllotment_(d, ctx) {
  const e = {};
  if (!vRequired_(e, d, 'Employee_ID', 'Employee')) { /* message set */ }
  else if (!ctx.employee) e.Employee_ID = 'Selected employee was not found.';
  else if (ctx.employee.Employment_Status !== 'Active') e.Employee_ID = 'Only Active employees can receive new devices.';
  if (!vRequired_(e, d, 'Device_ID', 'Device')) { /* message set */ }
  else if (!ctx.device) e.Device_ID = 'Selected device was not found.';
  else if (ctx.device.Current_Status !== 'Available') e.Device_ID = 'This device is ' + ctx.device.Current_Status + ' and cannot be allotted.';
  else if (ctx.hasOpenAssignmentOnDevice) e.Device_ID = 'This device already has an active assignment.';
  vDate_(e, d, 'Issue_Date', 'Issue date', true);
  vRequired_(e, d, 'Issued_By', 'Issued by');
  vRequired_(e, d, 'Condition_At_Issue', 'Condition at issue'); vInList_(e, d, 'Condition_At_Issue', 'Condition at issue', ctx.lists['Device Conditions']);
  return e;
}

/** ctx: { assignment, lists } */
function validateReturn_(d, ctx) {
  const e = {}, a = ctx.assignment;
  if (!vRequired_(e, d, 'Assignment_ID', 'Assignment')) { /* message set */ }
  else if (!a) e.Assignment_ID = 'Assignment not found.';
  else if (a.Assignment_Status !== OPEN_STATUS) e.Assignment_ID = 'This assignment is already ' + a.Assignment_Status + '. A device cannot be returned twice.';
  const ok = vDate_(e, d, 'Return_Date', 'Actual return date', true);
  if (ok) {
    if (d.Return_Date > Dates_.today()) e.Return_Date = 'Actual return date cannot be in the future.';
    else if (a && d.Return_Date < a.Issue_Date) e.Return_Date = 'Return date cannot be before the allocated date (' + a.Issue_Date + ').';
  }
  vRequired_(e, d, 'Condition_At_Return', 'Condition at return'); vInList_(e, d, 'Condition_At_Return', 'Condition at return', ctx.lists['Device Conditions']);
  vRequired_(e, d, 'Received_By', 'Received by');
  if (has_(d.Device_Status_After) && ['Available', 'Under Repair'].indexOf(d.Device_Status_After) === -1) e.Device_Status_After = 'Choose Available or Under Repair.';
  return e;
}

/* ============================ 5. DASHBOARD OPERATIONS ============================ */
/* Each operation receives (state, args, today), changes the in-memory state or throws a RuleError.
   Nothing here touches the spreadsheet; section 6 writes the difference afterwards. */

const DEVICE_FIELDS = ['Device_ID', 'Asset_Tag', 'Device_Type', 'Brand', 'Model', 'Serial_Number', 'Device_Ownership_Type', 'Rental_Vendor', 'Rental_Start_Date', 'Rental_End_Date', 'Device_Condition', 'Current_Status', 'Notes'];
const EMPLOYEE_FIELDS = ['Employee_ID', 'Employee_Name', 'Work_Email', 'Department', 'Designation', 'Manager_Name', 'Joining_Date', 'Employment_Status', 'Last_Working_Date', 'Notes'];
const ALLOTMENT_FIELDS = ['Employee_ID', 'Device_ID', 'Issue_Date', 'Issued_By', 'Condition_At_Issue', 'Accessories_Issued', 'Remarks'];
const RETURN_FIELDS = ['Assignment_ID', 'Return_Date', 'Condition_At_Return', 'Device_Status_After', 'Accessories_Returned', 'Missing_Items', 'Received_By', 'Remarks'];

function clearRentalIfOwned_(d) {
  if (d.Device_Ownership_Type !== 'Rented') { d.Rental_Vendor = ''; d.Rental_Start_Date = ''; d.Rental_End_Date = ''; }
}

const OPERATIONS = {
  saveDevice: function (s, a) {
    const d = cleanInput_(a[0], DEVICE_FIELDS);
    if (!has_(d.Device_ID)) d.Device_ID = nextId_('DEV-', 4, s.devices, 'Device_ID');
    clearRentalIfOwned_(d);
    const errs = validateDevice_(d, { devices: s.devices, lists: s.lists });
    if (!isEmpty_(errs)) fail_rule_(errs);
    s.devices.push(d);
    return d;
  },

  updateDevice: function (s, a) {
    const d = cleanInput_(a[0], DEVICE_FIELDS), ix = indexState_(s), cur = ix.dev[d.Device_ID];
    if (!cur) throw ruleError_('Device ' + d.Device_ID + ' was not found.');
    clearRentalIfOwned_(d);
    const errs = validateDevice_(d, { devices: s.devices, lists: s.lists, editingId: cur.Device_ID, hasOpenAssignment: !!ix.openByDevice[cur.Device_ID] });
    if (!isEmpty_(errs)) fail_rule_(errs);
    DEVICE_FIELDS.forEach(function (f) { if (f !== 'Device_ID') cur[f] = d[f]; });
    return cur;
  },

  retireDevice: function (s, a) {
    const id = String(a[0] === undefined || a[0] === null ? '' : a[0]).trim(), ix = indexState_(s), d = ix.dev[id];
    if (!d) throw ruleError_('Device not found.');
    if (ix.openByDevice[id] || d.Current_Status === 'Assigned') throw ruleError_('This device is currently allotted. Process its return before retiring it.');
    if (d.Current_Status === 'Retired') throw ruleError_('This device is already retired.');
    d.Current_Status = 'Retired';
    return d;
  },

  saveEmployee: function (s, a) {
    const d = cleanInput_(a[0], EMPLOYEE_FIELDS);
    if (d.Employment_Status === 'Active') d.Last_Working_Date = '';
    const errs = validateEmployee_(d, { employees: s.employees, lists: s.lists });
    if (!isEmpty_(errs)) fail_rule_(errs);
    s.employees.push(d);
    return d;
  },

  updateEmployee: function (s, a) {
    const d = cleanInput_(a[0], EMPLOYEE_FIELDS), ix = indexState_(s), cur = ix.emp[d.Employee_ID];
    if (!cur) throw ruleError_('Employee ' + d.Employee_ID + ' was not found.');
    if (d.Employment_Status === 'Active') d.Last_Working_Date = '';
    const errs = validateEmployee_(d, { employees: s.employees, lists: s.lists, editingId: cur.Employee_ID });
    if (!isEmpty_(errs)) fail_rule_(errs);
    EMPLOYEE_FIELDS.forEach(function (f) { if (f !== 'Employee_ID') cur[f] = d[f]; });
    return cur;
  },

  /** Allots an Available device to an Active employee. An employee may hold many devices; a device only one. */
  createAssignment: function (s, a) {
    const d = cleanInput_(a[0], ALLOTMENT_FIELDS), ix = indexState_(s);
    const emp = ix.emp[d.Employee_ID], dev = ix.dev[d.Device_ID];
    const errs = validateAllotment_(d, { employee: emp, device: dev, hasOpenAssignmentOnDevice: !!(dev && ix.openByDevice[dev.Device_ID]), lists: s.lists });
    if (!isEmpty_(errs)) fail_rule_(errs);
    const rec = {
      Assignment_ID: nextId_('ASG-', 4, s.assignments, 'Assignment_ID'), Employee_ID: emp.Employee_ID, Device_ID: dev.Device_ID, Issue_Date: d.Issue_Date, Issued_By: d.Issued_By,
      Condition_At_Issue: d.Condition_At_Issue, Accessories_Issued: d.Accessories_Issued, Assignment_Status: 'Active', Return_Date: '', Return_ID: '', Remarks: d.Remarks
    };
    s.assignments.push(rec);
    dev.Current_Status = 'Assigned';
    return rec;
  },

  /** For an allotment made by mistake: the row is kept, marked Cancelled, and the device becomes Available again. */
  cancelAssignment: function (s, a) {
    const d = cleanInput_(a[0], ['Assignment_ID', 'Remarks']), ix = indexState_(s), asg = ix.asg[d.Assignment_ID];
    if (!asg) throw ruleError_('Assignment not found.');
    if (asg.Assignment_Status !== OPEN_STATUS) throw ruleError_('Only an Active assignment can be cancelled. This one is ' + asg.Assignment_Status + '.');
    if ((ix.retByAsg[asg.Assignment_ID] || []).length) throw ruleError_('This assignment already has return records and cannot be cancelled.');
    asg.Assignment_Status = 'Cancelled';
    asg.Remarks = (asg.Remarks ? asg.Remarks + ' | ' : '') + 'Cancelled: ' + (d.Remarks || 'allotment cancelled by admin');
    ix.dev[asg.Device_ID].Current_Status = 'Available';
    return asg;
  },

  /** The single return step. An Active assignment can be returned exactly once. */
  markReturned: function (s, a) {
    const d = cleanInput_(a[0], RETURN_FIELDS), ix = indexState_(s), asg = ix.asg[d.Assignment_ID];
    const errs = validateReturn_(d, { assignment: asg, lists: s.lists });
    if (!isEmpty_(errs)) fail_rule_(errs);
    if ((ix.retByAsg[asg.Assignment_ID] || []).length || has_(asg.Return_ID)) throw ruleError_('A return is already recorded for this assignment.', { Assignment_ID: 'Already returned.' });
    const dev = ix.dev[asg.Device_ID];
    const cond = d.Condition_At_Return;
    let status;
    if (cond === 'Damaged') status = DEVICE_STATUS_RETURN_REPAIR;
    else if (cond === 'New' || cond === 'Good') status = 'Available';
    else status = d.Device_Status_After === 'Under Repair' ? 'Under Repair' : 'Available'; // Fair: admin decides
    if (dev.Current_Status === 'Lost' || dev.Current_Status === 'Retired') status = dev.Current_Status; // never made Available
    const rec = {
      Return_ID: nextId_('RET-', 4, s.returns, 'Return_ID'), Assignment_ID: asg.Assignment_ID, Device_ID: asg.Device_ID, Employee_ID: asg.Employee_ID, Physical_Return_Date: d.Return_Date,
      Condition_At_Return: cond, Accessories_Returned: d.Accessories_Returned, Missing_Items: d.Missing_Items, Received_By: d.Received_By, Remarks: d.Remarks
    };
    s.returns.push(rec);
    asg.Assignment_Status = 'Returned'; asg.Return_Date = d.Return_Date; asg.Return_ID = rec.Return_ID;
    dev.Current_Status = status;
    dev.Device_Condition = cond;
    const out = clone_(rec); out._deviceStatus = status;
    return out;
  },

  /** Admin decision for a device that will not come back: closes the assignment and marks the device Lost. */
  resolveOutstandingAsLost: function (s, a, today) {
    const d = cleanInput_(a[0], ['Assignment_ID', 'Remarks']), ix = indexState_(s), asg = ix.asg[d.Assignment_ID];
    if (!asg) throw ruleError_('Assignment not found.');
    if (asg.Assignment_Status !== OPEN_STATUS) throw ruleError_('This assignment is already ' + asg.Assignment_Status + '.');
    if (!has_(d.Remarks)) fail_rule_({ Remarks: 'Add a remark explaining the loss decision.' });
    const rec = { Return_ID: nextId_('RET-', 4, s.returns, 'Return_ID'), Assignment_ID: asg.Assignment_ID, Device_ID: asg.Device_ID, Employee_ID: asg.Employee_ID, Physical_Return_Date: today, Condition_At_Return: '', Accessories_Returned: '', Missing_Items: 'Entire device', Received_By: '', Remarks: 'Resolved as lost: ' + d.Remarks };
    s.returns.push(rec);
    asg.Assignment_Status = 'Returned'; asg.Return_Date = today; asg.Return_ID = rec.Return_ID;
    ix.dev[asg.Device_ID].Current_Status = 'Lost';
    return rec;
  },

  addListValue: function (s, a) {
    const name = String(a[0] === undefined || a[0] === null ? '' : a[0]).trim(), value = String(a[1] === undefined || a[1] === null ? '' : a[1]).trim();
    if (!s.lists[name]) throw ruleError_('Unknown list.');
    if (LOCKED_LISTS.indexOf(name) !== -1) throw ruleError_(name + ' drives workflow rules and is locked.');
    if (!value) throw ruleError_('Enter a value to add.');
    if (value.length > 100) throw ruleError_('The value is too long.');
    if (s.lists[name].some(function (v) { return v.toLowerCase() === value.toLowerCase(); })) throw ruleError_('"' + value + '" is already in this list.');
    s.lists[name].push(value);
    return s.lists[name];
  },

  removeListValue: function (s, a) {
    const name = String(a[0] === undefined || a[0] === null ? '' : a[0]).trim(), value = String(a[1] === undefined || a[1] === null ? '' : a[1]);
    if (!s.lists[name]) throw ruleError_('Unknown list.');
    if (LOCKED_LISTS.indexOf(name) !== -1) throw ruleError_(name + ' is locked.');
    if ((PROTECTED_VALUES[name] || []).indexOf(value) !== -1) throw ruleError_('"' + value + '" is required by the workflow and cannot be removed.');
    const usage = {
      'Departments': function (x) { return s.employees.filter(function (r) { return r.Department === x; }).length; },
      'Designations': function (x) { return s.employees.filter(function (r) { return r.Designation === x; }).length; },
      'Device Types': function (x) { return s.devices.filter(function (r) { return r.Device_Type === x; }).length; },
      'Brands': function (x) { return s.devices.filter(function (r) { return r.Brand === x; }).length; },
      'Device Conditions': function (x) { return s.devices.filter(function (r) { return r.Device_Condition === x; }).length; }
    };
    const n = usage[name] ? usage[name](value) : 0;
    if (n > 0) throw ruleError_('"' + value + '" is used by ' + n + ' record' + (n > 1 ? 's' : '') + ' and cannot be removed.');
    s.lists[name] = s.lists[name].filter(function (v) { return v !== value; });
    return s.lists[name];
  }
};

/* ============================ 6. SPREADSHEET READ / WRITE ============================ */
/* Columns are located by header name (row 1). Extra columns are never touched. Everything is stored
   as plain text, with dates as YYYY-MM-DD, so Sheets cannot convert dates or run "=" text as formulas. */

function getBook_() {
  const id = String(PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID') || DEFAULT_SPREADSHEET_ID).trim();
  try { return SpreadsheetApp.openById(id); }
  catch (e) { throw new Error('The spreadsheet could not be opened. Make sure your Google account has Editor access to it. (Spreadsheet ID used: ' + id + '. Google said: ' + String(e && e.message ? e.message : e) + ')'); }
}

function normalizeCell_(v) {
  if (v === null || v === undefined) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    if (isNaN(v.getTime())) return '';
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return String(v).trim();
}

function headerMap_(sheet, tabName, required) {
  const width = Math.max(sheet.getLastColumn(), 1);
  const row = sheet.getRange(1, 1, 1, width).getValues()[0].map(function (h) { return String(h === null || h === undefined ? '' : h).trim(); });
  const map = {};
  row.forEach(function (h, i) { if (h && map[h] === undefined) map[h] = i; });
  const missing = required.filter(function (h) { return map[h] === undefined; });
  if (missing.length) throw new Error("Tab '" + tabName + "' is missing the column header(s): " + missing.join(', ') + '. Headers must match exactly (row 1).');
  return { map: map, width: width };
}

function readTable_(book, key) {
  const def = TABLES[key];
  const sheet = book.getSheetByName(def.tab);
  if (!sheet) throw new Error("The tab '" + def.tab + "' was not found in the spreadsheet.");
  const hm = headerMap_(sheet, def.tab, def.headers);
  const last = sheet.getLastRow();
  const records = [], rowOf = {};
  if (last >= 2) {
    sheet.getRange(2, 1, last - 1, hm.width).getValues().forEach(function (r, i) {
      const rec = {};
      def.headers.forEach(function (h) { rec[h] = normalizeCell_(r[hm.map[h]]); });
      const id = rec[def.idField];
      if (!id) return; // a row without an ID is ignored
      if (rowOf[id] !== undefined) throw new Error('Duplicate ' + def.idField + " '" + id + "' in tab '" + def.tab + "' (rows " + rowOf[id] + ' and ' + (i + 2) + '). Fix the sheet before using the dashboard.');
      records.push(rec); rowOf[id] = i + 2;
    });
  }
  return { records: records, rowOf: rowOf, hm: hm, sheet: sheet };
}

function readLists_(book) {
  const sheet = book.getSheetByName(LISTS_TAB);
  if (!sheet) throw new Error("The tab '" + LISTS_TAB + "' was not found in the spreadsheet.");
  const hm = headerMap_(sheet, LISTS_TAB, LISTS_HEADERS);
  const last = sheet.getLastRow(), lists = {};
  if (last >= 2) {
    sheet.getRange(2, 1, last - 1, hm.width).getValues().forEach(function (r) {
      const name = normalizeCell_(r[hm.map.List_Name]), val = normalizeCell_(r[hm.map.Value]);
      if (!name || val === '') return;
      lists[name] = lists[name] || [];
      if (lists[name].indexOf(val) === -1) lists[name].push(val);
    });
  }
  Object.keys(DEFAULT_LISTS).forEach(function (k) { if (!lists[k] || !lists[k].length) lists[k] = DEFAULT_LISTS[k].slice(); });
  return { lists: lists, sheet: sheet, hm: hm };
}

/** Reads all five tabs. Returns the state the operations work on plus the row bookkeeping needed to write back. */
function loadState_() {
  const book = getBook_(), meta = { tables: {} }, state = {};
  Object.keys(TABLES).forEach(function (k) {
    const t = readTable_(book, k);
    meta.tables[k] = t; state[k] = t.records;
  });
  const l = readLists_(book);
  meta.lists = l; state.lists = l.lists;
  return { state: state, meta: meta };
}

function rowChanged_(def, a, b) {
  return def.headers.some(function (h) {
    return String(a[h] === undefined || a[h] === null ? '' : a[h]) !== String(b[h] === undefined || b[h] === null ? '' : b[h]);
  });
}

function writeRecords_(t, def, startRow, records) {
  const n = records.length;
  const cell = function (rec, h) { return rec[h] === undefined || rec[h] === null ? '' : String(rec[h]); };
  if (t.hm.width === def.headers.length) {
    const block = records.map(function (rec) {
      const row = new Array(t.hm.width);
      def.headers.forEach(function (h) { row[t.hm.map[h]] = cell(rec, h); });
      return row;
    });
    const rng = t.sheet.getRange(startRow, 1, n, t.hm.width);
    rng.setNumberFormat('@');
    rng.setValues(block);
    return;
  }
  def.headers.forEach(function (h) { // extra columns exist: write only the columns the dashboard owns
    const rng = t.sheet.getRange(startRow, t.hm.map[h] + 1, n, 1);
    rng.setNumberFormat('@');
    rng.setValues(records.map(function (rec) { return [cell(rec, h)]; }));
  });
}

function writeLists_(l, lists) {
  const rows = [];
  Object.keys(lists).forEach(function (name) { lists[name].forEach(function (v) { rows.push([name, v]); }); });
  const sheet = l.sheet, last = sheet.getLastRow();
  const cn = l.hm.map.List_Name + 1, cv = l.hm.map.Value + 1;
  if (last >= 2) { sheet.getRange(2, cn, last - 1, 1).clearContent(); sheet.getRange(2, cv, last - 1, 1).clearContent(); }
  if (!rows.length) return;
  const a = sheet.getRange(2, cn, rows.length, 1); a.setNumberFormat('@'); a.setValues(rows.map(function (r) { return [r[0]]; }));
  const b = sheet.getRange(2, cv, rows.length, 1); b.setNumberFormat('@'); b.setValues(rows.map(function (r) { return [r[1]]; }));
}

/** Compares the data before and after an operation and writes only the difference. Never deletes. */
function saveChanges_(loaded, before, after) {
  Object.keys(TABLES).forEach(function (k) {
    const def = TABLES[k], t = loaded.meta.tables[k];
    if (after[k].length < before[k].length) throw new Error('Deleting records is not allowed.');
    const prev = {};
    before[k].forEach(function (r) { prev[r[def.idField]] = r; });
    const appended = [], updated = [];
    after[k].forEach(function (rec) {
      const old = prev[rec[def.idField]];
      if (!old) appended.push(rec); else if (rowChanged_(def, old, rec)) updated.push(rec);
    });
    updated.forEach(function (rec) {
      const rowNumber = t.rowOf[rec[def.idField]];
      if (!rowNumber) throw new Error('The row for ' + rec[def.idField] + ' could not be located. Reload and try again.');
      writeRecords_(t, def, rowNumber, [rec]);
    });
    if (appended.length) writeRecords_(t, def, Math.max(t.sheet.getLastRow(), 1) + 1, appended);
  });
  if (JSON.stringify(after.lists) !== JSON.stringify(before.lists)) writeLists_(loaded.meta.lists, after.lists);
  SpreadsheetApp.flush();
}

/* ============================ 7. API (the only function the page calls) ============================ */

function ok_(data) { return { ok: true, data: data }; }

function fail_(err) {
  const isRule = !!err && err.name === 'RuleError';
  let message = err && err.message ? String(err.message) : 'Unexpected error.';
  if (!isRule) {
    console.error(message + (err && err.stack ? '\n' + err.stack : ''));
    if (/Lock timeout|Could not obtain lock/i.test(message)) message = 'Another change is being saved right now. Wait a moment and try again.';
  }
  return { ok: false, error: { name: isRule ? 'RuleError' : 'Error', message: message, fields: isRule ? (err.fields || {}) : {} } };
}

/**
 * api('whoami')                  -> { email }
 * api('loadAll')                 -> { snapshot }              snapshot = { employees, devices, assignments, returns, lists }
 * api('<operation>', [args...])  -> { result, snapshot }      operations: saveEmployee, updateEmployee, saveDevice, updateDevice,
 *                                  retireDevice, createAssignment, cancelAssignment, markReturned, resolveOutstandingAsLost,
 *                                  addListValue, removeListValue
 * Always returns { ok: true, data } or { ok: false, error: { name, message, fields } }.
 */
function api(method, args) {
  try {
    const email = currentEmail_();
    if (!email) throw new Error('Access denied: your Google email could not be identified. The web app must be deployed with "Execute as: User accessing the web app".');
    if (!isAdmin_(email)) throw new Error('Access denied for ' + email + '.');
    if (typeof method !== 'string') throw new Error('Invalid request.');
    args = args === undefined || args === null ? [] : args;
    if (Object.prototype.toString.call(args) !== '[object Array]') throw new Error('Invalid request.');
    if (JSON.stringify(args).length > MAX_REQUEST_CHARS) throw new Error('The request is too large.');

    if (method === 'whoami') return ok_({ email: email });
    if (method === 'loadAll') return ok_({ snapshot: loadState_().state });
    if (!Object.prototype.hasOwnProperty.call(OPERATIONS, method)) throw new Error('Unknown operation.');

    const lock = LockService.getScriptLock();
    lock.waitLock(LOCK_WAIT_MS); // only one change at a time, across all administrators
    try {
      const loaded = loadState_();
      const before = clone_(loaded.state);
      const result = OPERATIONS[method](loaded.state, args, Dates_.today()); // throws a RuleError if a rule is broken
      saveChanges_(loaded, before, loaded.state);
      return ok_({ result: result, snapshot: loaded.state });
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return fail_(err);
  }
}

/* ============================ 8. ONE-TIME SETUP + SELF-CHECK (run from the editor) ============================ */

/**
 * Run once. Verifies every tab and header, converts the data area of each tab to plain text (real dates
 * become YYYY-MM-DD text) and fills the Lists tab with the default dropdown values if it has none.
 * It never deletes rows.
 */
function setupSheets() {
  const book = getBook_(), report = [];
  Object.keys(TABLES).forEach(function (k) {
    const def = TABLES[k], sheet = book.getSheetByName(def.tab);
    if (!sheet) throw new Error("The tab '" + def.tab + "' was not found in the spreadsheet.");
    const hm = headerMap_(sheet, def.tab, def.headers);
    const last = sheet.getLastRow(), maxRows = sheet.getMaxRows();
    if (last >= 2) {
      const rng = sheet.getRange(2, 1, last - 1, hm.width);
      const vals = rng.getValues().map(function (r) { return r.map(normalizeCell_); });
      rng.setNumberFormat('@'); rng.setValues(vals);
    }
    const from = Math.max(last + 1, 2);
    if (maxRows >= from) sheet.getRange(from, 1, maxRows - from + 1, hm.width).setNumberFormat('@');
    report.push(def.tab + ': headers OK, ' + Math.max(last - 1, 0) + ' data row(s)');
  });
  const l = readLists_(book);
  if (l.sheet.getLastRow() < 2) { writeLists_(l, DEFAULT_LISTS); report.push('Lists: default dropdown values written'); }
  else report.push('Lists: existing values kept');
  SpreadsheetApp.flush();
  Logger.log('Setup complete.\n' + report.join('\n'));
  return report.join('\n');
}

/** Run from the editor to confirm the configuration without opening the web app. */
function checkSetup() {
  const out = [];
  out.push('Signed-in account (editor view): ' + (currentEmail_() || '(not available)'));
  out.push('Email identified: ' + (currentEmail_() ? 'yes' : 'NO'));
  out.push('Running as the signed-in user: ' + (currentEmail_() && currentEmail_() === effectiveEmail_() ? 'yes' : 'NO (check the deployment setting)'));
  out.push('Note: the real test is the web app itself. Open its URL with ?diag=1 at the end.');
  out.push('Administrators configured: ' + adminList_().length);
  const book = getBook_();
  out.push('Spreadsheet: ' + book.getName());
  const s = loadState_().state;
  out.push('Employees: ' + s.employees.length + ', Devices: ' + s.devices.length + ', Assignments: ' + s.assignments.length + ', Returns: ' + s.returns.length);
  out.push('Lists: ' + Object.keys(s.lists).length);
  Logger.log(out.join('\n'));
  return out.join('\n');
}
