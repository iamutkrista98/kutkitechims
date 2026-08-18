// seed-blank.js — minimal initialization for Gyan Kunj Secondary School.
//
// Unlike seed.js (which fills the app with a full realistic demo dataset
// for evaluation/testing), this script creates ONLY:
//   - the school's branding (name/tagline)
//   - one administrator account
//   - one staff account
// No departments, locations, categories, vendors, items, transfers,
// procurement requests, repairs, stocking plans, or petty cash entries are
// created — the database is left otherwise empty and ready for real data
// to be entered by hand through the app itself (Departments, Locations,
// Categories, Inventory, etc. are all manageable from the UI once signed
// in as the administrator below).
//
// Safe to run only once against a fresh database (same as seed.js) — the
// fixed user ids below will collide with rows from a previous run of
// either seed.js or seed-blank.js. If you need to start over, drop and
// recreate the database first.
'use strict';
const bcrypt = require('bcryptjs');
const db = require('./db');

const adminPw = bcrypt.hashSync('Admin@123', 8);
const staffPw = bcrypt.hashSync('Welcome@123', 8);
const today = () => new Date().toISOString().slice(0, 10);

const users = [
  {
    id: 'usr_1',
    name: 'Administrator',
    email: 'admin@gyankunj.edu.np',
    passwordHash: adminPw,
    role: 'admin',
    division: '',
    departmentIds: [],
    locationId: null,
    managerId: null,
    phone: '',
    avatarColor: '#1B2F63',
    avatarImage: null,
    status: 'active',
    createdAt: today(),
    dashboardAccess: null,
    scrapAccess: null,
    emailNotifications: true
  },
  {
    id: 'usr_2',
    name: 'Staff Member',
    email: 'staff@gyankunj.edu.np',
    passwordHash: staffPw,
    role: 'staff',
    division: '',
    departmentIds: [],
    locationId: null,
    managerId: null,
    phone: '',
    avatarColor: '#3F8F6A',
    avatarImage: null,
    status: 'active',
    createdAt: today(),
    dashboardAccess: null,
    scrapAccess: null,
    emailNotifications: true
  }
];

async function run() {
  await db.init();

  await db.saveSettings({
    schoolName: 'Gyan Kunj Secondary School',
    tagline: 'AssetTrack — Inventory & Asset Management'
  });

  await db.save('users', users);

  console.log('Seeded Gyan Kunj Secondary School — blank install.');
  console.log('Created: 1 administrator, 1 staff account. No demo data (departments, locations, categories, items, etc.) was created — add these from within the app.');
  console.log('Admin login:  admin@gyankunj.edu.np / Admin@123');
  console.log('Staff login:  staff@gyankunj.edu.np / Welcome@123');
  console.log('Change both passwords immediately after first login via My Profile → Change Password.');
}

run().then(() => {
  console.log('Seed complete.');
  process.exit(0);
}).catch(err => {
  console.error('Seed error:', err);
  process.exit(1);
});
