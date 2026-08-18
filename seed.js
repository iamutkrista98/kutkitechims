// seed.js — populates AssetTrack with a realistic starter dataset for
// Silver Oak School: staff across a few departments, the school's rooms
// and stores, item categories, a couple of vendors, and a mix of
// inventory (assets + consumables) with some transfers, procurement
// requests, and repair reports already in flight so the app doesn't look
// empty on first run.
const bcrypt = require('bcryptjs');
const db = require('./db');

const pw = bcrypt.hashSync('Welcome@123', 8);
const adminPw = bcrypt.hashSync('Admin@123', 8);
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString(); };
const dateAgo = (n) => daysAgo(n).slice(0, 10);

// ---------------------------------------------------------------------------
// Departments — the structured version of what used to be a free-text
// "division" string. Locations belong to one department (or none, for
// spaces genuinely shared across the school); users can belong to more
// than one, since e.g. a deputy head might oversee both Science and IT.
// ---------------------------------------------------------------------------
const departments = [
  { id: 'dep_admin', name: 'Administration', notes: 'Front office, records, and procurement administration.' },
  { id: 'dep_science', name: 'Science Department', notes: 'Physics, chemistry and biology labs.' },
  { id: 'dep_it', name: 'IT / Computer Lab', notes: 'Computer lab and school-wide IT equipment.' },
  { id: 'dep_library', name: 'Library', notes: '' },
  { id: 'dep_sports', name: 'Sports Department', notes: 'Outdoor and indoor sports equipment and facilities.' },
];
const allDeptIds = departments.map(d => d.id);

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------
const users = [
  { id: 'usr_1', name: 'Rajesh Shrestha', email: 'rajesh.shrestha@silveroak.edu.np', passwordHash: adminPw, role: 'admin', division: 'Administration', departmentIds: allDeptIds, locationId: 'loc_office', managerId: null, phone: '9841000001', avatarColor: '#1B2F63', avatarImage: null, status: 'active', createdAt: dateAgo(400) },
  { id: 'usr_2', name: 'Sunita Gurung', email: 'sunita.gurung@silveroak.edu.np', passwordHash: pw, role: 'manager', division: 'Science Department', departmentIds: ['dep_science'], locationId: 'loc_scilab', managerId: null, phone: '9841000002', avatarColor: '#274E8C', avatarImage: null, status: 'active', createdAt: dateAgo(380) },
  { id: 'usr_3', name: 'Bikash Thapa', email: 'bikash.thapa@silveroak.edu.np', passwordHash: pw, role: 'manager', division: 'IT / Computer Lab', departmentIds: ['dep_it'], locationId: 'loc_complab', managerId: null, phone: '9841000003', avatarColor: '#2E6B9E', avatarImage: null, status: 'active', createdAt: dateAgo(360) },
  { id: 'usr_4', name: 'Anita Rai', email: 'anita.rai@silveroak.edu.np', passwordHash: pw, role: 'staff', division: 'Science Department', departmentIds: ['dep_science'], locationId: 'loc_scilab', managerId: 'usr_2', phone: '9841000004', avatarColor: '#3F8F6A', avatarImage: null, status: 'active', createdAt: dateAgo(300) },
  { id: 'usr_5', name: 'Prakash Lama', email: 'prakash.lama@silveroak.edu.np', passwordHash: pw, role: 'staff', division: 'IT / Computer Lab', departmentIds: ['dep_it'], locationId: 'loc_complab', managerId: 'usr_3', phone: '9841000005', avatarColor: '#6DAF3C', avatarImage: null, status: 'active', createdAt: dateAgo(280) },
  { id: 'usr_6', name: 'Sarita Magar', email: 'sarita.magar@silveroak.edu.np', passwordHash: pw, role: 'staff', division: 'Library', departmentIds: ['dep_library'], locationId: 'loc_library', managerId: null, phone: '9841000006', avatarColor: '#8CC63F', avatarImage: null, status: 'active', createdAt: dateAgo(250) },
  { id: 'usr_7', name: 'Dipendra Karki', email: 'dipendra.karki@silveroak.edu.np', passwordHash: pw, role: 'staff', division: 'Sports Department', departmentIds: ['dep_sports'], locationId: 'loc_sports', managerId: null, phone: '9841000007', avatarColor: '#4A5D8A', avatarImage: null, status: 'active', createdAt: dateAgo(220) },
  { id: 'usr_8', name: 'Maya Tamang', email: 'maya.tamang@silveroak.edu.np', passwordHash: pw, role: 'staff', division: 'Science Department, IT / Computer Lab', departmentIds: ['dep_science', 'dep_it'], locationId: 'loc_scilab', managerId: 'usr_2', phone: '9841000008', avatarColor: '#2E4A93', avatarImage: null, status: 'active', createdAt: dateAgo(120) },
];

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------
const locations = [
  { id: 'loc_office', name: 'Main Office', type: 'Office', building: 'Building A', floor: 'Ground Floor', departmentId: 'dep_admin', departmentName: 'Administration', custodianId: 'usr_1', custodianName: 'Rajesh Shrestha', notes: 'Administration and procurement records.' },
  { id: 'loc_scilab', name: 'Science Laboratory', type: 'Lab', building: 'Building A', floor: 'First Floor', departmentId: 'dep_science', departmentName: 'Science Department', custodianId: 'usr_2', custodianName: 'Sunita Gurung', notes: 'Physics, chemistry and biology equipment.' },
  { id: 'loc_complab', name: 'Computer Lab', type: 'Lab', building: 'Building A', floor: 'Second Floor', departmentId: 'dep_it', departmentName: 'IT / Computer Lab', custodianId: 'usr_3', custodianName: 'Bikash Thapa', notes: '30-seat computer lab with server rack.' },
  { id: 'loc_library', name: 'Library', type: 'Library', building: 'Building B', floor: 'Ground Floor', departmentId: 'dep_library', departmentName: 'Library', custodianId: 'usr_6', custodianName: 'Sarita Magar', notes: '' },
  { id: 'loc_sports', name: 'Sports Store', type: 'Store', building: 'Building C', floor: 'Ground Floor', departmentId: 'dep_sports', departmentName: 'Sports Department', custodianId: 'usr_7', custodianName: 'Dipendra Karki', notes: 'Outdoor and indoor sports equipment.' },
  { id: 'loc_staffroom', name: 'Staff Room', type: 'Room', building: 'Building A', floor: 'First Floor', departmentId: null, departmentName: null, custodianId: null, custodianName: null, notes: 'Shared space — visible to every department.' },
  { id: 'loc_6a', name: 'Classroom 6A', type: 'Classroom', building: 'Building B', floor: 'First Floor', departmentId: null, departmentName: null, custodianId: null, custodianName: null, notes: '' },
  { id: 'loc_7b', name: 'Classroom 7B', type: 'Classroom', building: 'Building B', floor: 'Second Floor', departmentId: null, departmentName: null, custodianId: null, custodianName: null, notes: '' },
  { id: 'loc_auditorium', name: 'Auditorium', type: 'Hall', building: 'Building C', floor: 'Ground Floor', departmentId: null, departmentName: null, custodianId: null, custodianName: null, notes: 'Assembly hall and events space — shared.' },
  { id: 'loc_store', name: 'Central Store', type: 'Store', building: 'Building A', floor: 'Basement', departmentId: null, departmentName: null, custodianId: 'usr_1', custodianName: 'Rajesh Shrestha', sharedAccess: true, notes: 'General stationery and supplies store — shared with every department.' },
];

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------
const categories = [
  { id: 'cat_it', name: 'IT Equipment', trackingType: 'asset', defaultUnit: 'pcs' },
  { id: 'cat_lab', name: 'Lab Equipment', trackingType: 'asset', defaultUnit: 'pcs' },
  { id: 'cat_furniture', name: 'Furniture', trackingType: 'asset', defaultUnit: 'pcs' },
  { id: 'cat_sports', name: 'Sports Equipment', trackingType: 'stock', defaultUnit: 'pcs' },
  { id: 'cat_library', name: 'Library Resources', trackingType: 'stock', defaultUnit: 'copies' },
  { id: 'cat_stationery', name: 'Stationery & Consumables', trackingType: 'stock', defaultUnit: 'box' },
  { id: 'cat_music', name: 'Musical Instruments', trackingType: 'asset', defaultUnit: 'pcs' },
  { id: 'cat_cleaning', name: 'Cleaning Supplies', trackingType: 'stock', defaultUnit: 'box' },
];

// ---------------------------------------------------------------------------
// Vendors
// ---------------------------------------------------------------------------
const vendors = [
  { id: 'ven_tech', name: 'TechSource Nepal', contactPerson: 'Rabin Shah', phone: '01-4123456', email: 'sales@techsource.com.np', address: 'New Baneshwor, Kathmandu', supplies: 'IT Equipment', notes: '' },
  { id: 'ven_edulab', name: 'EduLab Suppliers Pvt. Ltd.', contactPerson: 'Kiran Joshi', phone: '01-4223344', email: 'info@edulab.com.np', address: 'Putalisadak, Kathmandu', supplies: 'Lab Equipment', notes: '' },
  { id: 'ven_sports', name: 'Himalayan Sports House', contactPerson: 'Suman Basnet', phone: '01-4334455', email: 'contact@himalayansports.com.np', address: 'New Road, Kathmandu', supplies: 'Sports Equipment', notes: '' },
  { id: 'ven_book', name: 'Nepal Book Depot', contactPerson: 'Meena Shrestha', phone: '01-4445566', email: 'orders@nepalbookdepot.com.np', address: 'Kirtipur, Kathmandu', supplies: 'Library Resources', notes: '' },
  { id: 'ven_stationery', name: 'Om Stationery Traders', contactPerson: 'Hari Adhikari', phone: '01-4556677', email: 'om.stationery@gmail.com', address: 'Koteshwor, Kathmandu', supplies: 'Stationery & Consumables', notes: '' },
];

// ---------------------------------------------------------------------------
// Items — a realistic mix of assets and stock across locations
// ---------------------------------------------------------------------------
const items = [
  { id: 'itm_1', name: 'Dell OptiPlex Desktop Computer', categoryId: 'cat_it', categoryName: 'IT Equipment', trackingType: 'asset', assetTag: 'IT-0001', serialNumber: 'DL7090-3321', locationId: 'loc_complab', locationName: 'Computer Lab', quantity: 1, unit: 'pcs', condition: 'good', purchaseDate: dateAgo(300), purchaseCost: 65000, vendorId: 'ven_tech', vendorName: 'TechSource Nepal', warrantyExpiry: '2027-06-30', minStockLevel: null, notes: 'Lab workstation #1', photoImage: null, procurementRequestId: null, createdAt: dateAgo(300) },
  { id: 'itm_2', name: 'Epson Projector EB-X06', categoryId: 'cat_it', categoryName: 'IT Equipment', trackingType: 'asset', assetTag: 'IT-0002', serialNumber: 'EPX06-8842', locationId: 'loc_7b', locationName: 'Classroom 7B', quantity: 1, unit: 'pcs', condition: 'under_repair', purchaseDate: dateAgo(500), purchaseCost: 48000, vendorId: 'ven_tech', vendorName: 'TechSource Nepal', warrantyExpiry: '2025-01-15', minStockLevel: null, notes: 'Bulb flickering intermittently.', photoImage: null, procurementRequestId: null, createdAt: dateAgo(500) },
  { id: 'itm_3', name: 'HP LaserJet Printer', categoryId: 'cat_it', categoryName: 'IT Equipment', trackingType: 'asset', assetTag: 'IT-0003', serialNumber: 'HPLJ-5567', locationId: 'loc_office', locationName: 'Main Office', quantity: 1, unit: 'pcs', condition: 'good', purchaseDate: dateAgo(200), purchaseCost: 22000, vendorId: 'ven_tech', vendorName: 'TechSource Nepal', warrantyExpiry: '2026-03-01', minStockLevel: null, notes: '', photoImage: null, procurementRequestId: null, createdAt: dateAgo(200) },
  { id: 'itm_4', name: 'Microscope (Compound, 1000x)', categoryId: 'cat_lab', categoryName: 'Lab Equipment', trackingType: 'asset', assetTag: 'LAB-0001', serialNumber: 'MC1000-114', locationId: 'loc_scilab', locationName: 'Science Laboratory', quantity: 1, unit: 'pcs', condition: 'good', purchaseDate: dateAgo(600), purchaseCost: 18500, vendorId: 'ven_edulab', vendorName: 'EduLab Suppliers Pvt. Ltd.', warrantyExpiry: null, minStockLevel: null, notes: '', photoImage: null, procurementRequestId: null, createdAt: dateAgo(600) },
  { id: 'itm_5', name: 'Bunsen Burner', categoryId: 'cat_lab', categoryName: 'Lab Equipment', trackingType: 'asset', assetTag: 'LAB-0002', serialNumber: '', locationId: 'loc_scilab', locationName: 'Science Laboratory', quantity: 1, unit: 'pcs', condition: 'damaged', purchaseDate: dateAgo(700), purchaseCost: 1200, vendorId: 'ven_edulab', vendorName: 'EduLab Suppliers Pvt. Ltd.', warrantyExpiry: null, minStockLevel: null, notes: 'Gas valve cracked.', photoImage: null, procurementRequestId: null, createdAt: dateAgo(700) },
  { id: 'itm_6', name: 'Skeleton Model (Full Size)', categoryId: 'cat_lab', categoryName: 'Lab Equipment', trackingType: 'asset', assetTag: 'LAB-0003', serialNumber: '', locationId: 'loc_scilab', locationName: 'Science Laboratory', quantity: 1, unit: 'pcs', condition: 'disposed', purchaseDate: dateAgo(1200), purchaseCost: 9000, vendorId: 'ven_edulab', vendorName: 'EduLab Suppliers Pvt. Ltd.', warrantyExpiry: null, minStockLevel: null, notes: 'Beyond repair, written off.', photoImage: null, procurementRequestId: null, createdAt: dateAgo(1200) },
  { id: 'itm_7', name: 'Student Desk & Chair Set', categoryId: 'cat_furniture', categoryName: 'Furniture', trackingType: 'asset', assetTag: 'FUR-0012', serialNumber: '', locationId: 'loc_6a', locationName: 'Classroom 6A', quantity: 1, unit: 'pcs', condition: 'fair', purchaseDate: dateAgo(900), purchaseCost: 4500, vendorId: null, vendorName: null, warrantyExpiry: null, minStockLevel: null, notes: '', photoImage: null, procurementRequestId: null, createdAt: dateAgo(900) },
  { id: 'itm_8', name: "Principal's Office Chair", categoryId: 'cat_furniture', categoryName: 'Furniture', trackingType: 'asset', assetTag: 'FUR-0001', serialNumber: '', locationId: 'loc_office', locationName: 'Main Office', quantity: 1, unit: 'pcs', condition: 'good', purchaseDate: dateAgo(450), purchaseCost: 12000, vendorId: null, vendorName: null, warrantyExpiry: null, minStockLevel: null, notes: '', photoImage: null, procurementRequestId: null, createdAt: dateAgo(450) },
  { id: 'itm_9', name: 'Football', categoryId: 'cat_sports', categoryName: 'Sports Equipment', trackingType: 'stock', assetTag: null, serialNumber: null, locationId: 'loc_sports', locationName: 'Sports Store', quantity: 8, unit: 'pcs', condition: 'good', purchaseDate: dateAgo(150), purchaseCost: 1800, vendorId: 'ven_sports', vendorName: 'Himalayan Sports House', warrantyExpiry: null, minStockLevel: 5, notes: '', photoImage: null, procurementRequestId: null, createdAt: dateAgo(150) },
  { id: 'itm_10', name: 'Badminton Racket', categoryId: 'cat_sports', categoryName: 'Sports Equipment', trackingType: 'stock', assetTag: null, serialNumber: null, locationId: 'loc_sports', locationName: 'Sports Store', quantity: 4, unit: 'pcs', condition: 'good', stockingMethod: 'lifo', reorderQty: 10, purchaseDate: dateAgo(150), purchaseCost: 900, vendorId: 'ven_sports', vendorName: 'Himalayan Sports House', warrantyExpiry: null, minStockLevel: 6, notes: 'Running low — reorder soon.', photoImage: null, procurementRequestId: null, createdAt: dateAgo(150) },
  { id: 'itm_11', name: 'A4 Paper Ream', categoryId: 'cat_stationery', categoryName: 'Stationery & Consumables', trackingType: 'stock', assetTag: null, serialNumber: null, locationId: 'loc_store', locationName: 'Central Store', quantity: 40, unit: 'ream', condition: 'good', stockingMethod: 'fifo', reorderQty: 30, purchaseDate: dateAgo(60), purchaseCost: 550, vendorId: 'ven_stationery', vendorName: 'Om Stationery Traders', warrantyExpiry: null, minStockLevel: 15, notes: '', photoImage: null, procurementRequestId: null, createdAt: dateAgo(60) },
  { id: 'itm_12', name: 'Whiteboard Marker (Box of 12)', categoryId: 'cat_stationery', categoryName: 'Stationery & Consumables', trackingType: 'stock', assetTag: null, serialNumber: null, locationId: 'loc_store', locationName: 'Central Store', quantity: 3, unit: 'box', condition: 'good', purchaseDate: dateAgo(90), purchaseCost: 850, vendorId: 'ven_stationery', vendorName: 'Om Stationery Traders', warrantyExpiry: null, minStockLevel: 5, notes: 'Below reorder level.', photoImage: null, procurementRequestId: null, createdAt: dateAgo(90) },
  { id: 'itm_13', name: 'Science Textbook Set (Grade 8)', categoryId: 'cat_library', categoryName: 'Library Resources', trackingType: 'stock', assetTag: null, serialNumber: null, locationId: 'loc_library', locationName: 'Library', quantity: 55, unit: 'copies', condition: 'good', purchaseDate: dateAgo(500), purchaseCost: 350, vendorId: 'ven_book', vendorName: 'Nepal Book Depot', warrantyExpiry: null, minStockLevel: 10, notes: '', photoImage: null, procurementRequestId: null, createdAt: dateAgo(500) },
  { id: 'itm_14', name: 'Tabla Set', categoryId: 'cat_music', categoryName: 'Musical Instruments', trackingType: 'asset', assetTag: 'MUS-0001', serialNumber: '', locationId: 'loc_auditorium', locationName: 'Auditorium', quantity: 1, unit: 'pcs', condition: 'good', purchaseDate: dateAgo(800), purchaseCost: 15000, vendorId: null, vendorName: null, warrantyExpiry: null, minStockLevel: null, notes: '', photoImage: null, procurementRequestId: null, createdAt: dateAgo(800) },
  { id: 'itm_15', name: 'Hand Sanitizer (5L Can)', categoryId: 'cat_cleaning', categoryName: 'Cleaning Supplies', trackingType: 'stock', assetTag: null, serialNumber: null, locationId: 'loc_store', locationName: 'Central Store', quantity: 6, unit: 'can', condition: 'good', purchaseDate: dateAgo(40), purchaseCost: 1100, vendorId: null, vendorName: null, warrantyExpiry: null, minStockLevel: 4, notes: '', photoImage: null, procurementRequestId: null, createdAt: dateAgo(40) },
  { id: 'itm_16', name: 'Laptop (Staff Room Shared)', categoryId: 'cat_it', categoryName: 'IT Equipment', trackingType: 'asset', assetTag: 'IT-0004', serialNumber: 'LEN-T14-9012', locationId: 'loc_staffroom', locationName: 'Staff Room', quantity: 1, unit: 'pcs', condition: 'good', purchaseDate: dateAgo(120), purchaseCost: 85000, vendorId: 'ven_tech', vendorName: 'TechSource Nepal', warrantyExpiry: '2027-01-10', minStockLevel: null, notes: '', photoImage: null, procurementRequestId: null, createdAt: dateAgo(120) },
];

// ---------------------------------------------------------------------------
// Condition history for the more "storied" items
// ---------------------------------------------------------------------------
const conditionLogs = [
  { id: 'log_1', itemId: 'itm_1', itemName: items[0].name, previousCondition: null, newCondition: 'good', note: 'Added to inventory', loggedById: 'usr_1', loggedByName: 'Rajesh Shrestha', loggedAt: daysAgo(300) },
  { id: 'log_2', itemId: 'itm_2', itemName: items[1].name, previousCondition: 'good', newCondition: 'under_repair', note: 'Repair reported: Bulb flickering intermittently.', loggedById: 'usr_5', loggedByName: 'Prakash Lama', loggedAt: daysAgo(4) },
  { id: 'log_3', itemId: 'itm_5', itemName: items[4].name, previousCondition: 'fair', newCondition: 'damaged', note: 'Gas valve cracked during practical class.', loggedById: 'usr_4', loggedByName: 'Anita Rai', loggedAt: daysAgo(20) },
  { id: 'log_4', itemId: 'itm_6', itemName: items[5].name, previousCondition: 'damaged', newCondition: 'disposed', note: 'Beyond repair — written off by administration.', loggedById: 'usr_1', loggedByName: 'Rajesh Shrestha', loggedAt: daysAgo(60) },
];

// ---------------------------------------------------------------------------
// Transfers — a mix of pending / approved
// ---------------------------------------------------------------------------
const transfers = [
  {
    id: 'trf_1', itemId: 'itm_16', itemName: 'Laptop (Staff Room Shared)',
    fromLocationId: 'loc_staffroom', fromLocationName: 'Staff Room', toLocationId: 'loc_complab', toLocationName: 'Computer Lab',
    quantity: null, requestedById: 'usr_5', requestedByName: 'Prakash Lama', reason: 'Needed for a coding workshop running all week in the computer lab.',
    managerDecision: 'pending', managerReviewedBy: null, managerReviewedAt: null,
    adminDecision: 'pending', adminReviewedBy: null, adminReviewedAt: null,
    status: 'pending', createdAt: daysAgo(1), completedAt: null
  },
  {
    id: 'trf_2', itemId: 'itm_11', itemName: 'A4 Paper Ream',
    fromLocationId: 'loc_store', fromLocationName: 'Central Store', toLocationId: 'loc_office', toLocationName: 'Main Office',
    quantity: 10, requestedById: 'usr_1', requestedByName: 'Rajesh Shrestha', reason: 'Office printer running low ahead of exam season.',
    managerDecision: 'not_required', managerReviewedBy: null, managerReviewedAt: null,
    adminDecision: 'approved', adminReviewedBy: 'Rajesh Shrestha', adminReviewedAt: daysAgo(5),
    status: 'approved', createdAt: daysAgo(6), completedAt: daysAgo(5)
  }
];

// ---------------------------------------------------------------------------
// Procurement requests — pending, approved-not-received, and received
// ---------------------------------------------------------------------------
const procurementRequests = [
  {
    id: 'pr_1', requestedById: 'usr_4', requestedByName: 'Anita Rai', division: 'Science Department',
    itemName: 'Digital Weighing Scale', categoryId: 'cat_lab', categoryName: 'Lab Equipment', quantity: 2, unit: 'pcs',
    estimatedCost: 6000, vendorId: 'ven_edulab', vendorName: 'EduLab Suppliers Pvt. Ltd.',
    justification: 'Needed for the Grade 9 practical syllabus this term — we currently only have one working scale.',
    managerDecision: 'pending', managerReviewedBy: null, managerReviewedAt: null,
    adminDecision: 'pending', adminReviewedBy: null, adminReviewedAt: null,
    status: 'pending', receivedItemId: null, createdAt: daysAgo(2), orderedAt: null, receivedAt: null
  },
  {
    id: 'pr_2', requestedById: 'usr_7', requestedByName: 'Dipendra Karki', division: 'Sports Department',
    itemName: 'Badminton Racket', categoryId: 'cat_sports', categoryName: 'Sports Equipment', quantity: 10, unit: 'pcs',
    estimatedCost: 9000, vendorId: 'ven_sports', vendorName: 'Himalayan Sports House',
    justification: "Current stock has dropped below what's needed for the inter-house tournament next month.",
    managerDecision: 'not_required', managerReviewedBy: null, managerReviewedAt: null,
    adminDecision: 'approved', adminReviewedBy: 'Rajesh Shrestha', adminReviewedAt: daysAgo(3),
    status: 'approved', receivedItemId: null, createdAt: daysAgo(7), orderedAt: daysAgo(3), receivedAt: null
  },
  {
    id: 'pr_3', requestedById: 'usr_6', requestedByName: 'Sarita Magar', division: 'Library',
    itemName: 'Nepali Literature Reference Set', categoryId: 'cat_library', categoryName: 'Library Resources', quantity: 20, unit: 'copies',
    estimatedCost: 8000, vendorId: 'ven_book', vendorName: 'Nepal Book Depot',
    justification: 'To refresh the reference section ahead of the new academic year.',
    managerDecision: 'not_required', managerReviewedBy: null, managerReviewedAt: null,
    adminDecision: 'approved', adminReviewedBy: 'Rajesh Shrestha', adminReviewedAt: daysAgo(30),
    status: 'approved', receivedItemId: 'itm_13', createdAt: daysAgo(40), orderedAt: daysAgo(30), receivedAt: daysAgo(25)
  }
];

// ---------------------------------------------------------------------------
// Repair requests — reported, in repair, and resolved
// ---------------------------------------------------------------------------
const repairRequests = [
  {
    id: 'rep_1', itemId: 'itm_2', itemName: 'Epson Projector EB-X06', locationId: 'loc_7b', locationName: 'Classroom 7B',
    reportedById: 'usr_5', reportedByName: 'Prakash Lama', issue: 'Bulb flickering intermittently during class, sometimes cuts out entirely.',
    priority: 'high', status: 'in_repair', assignedVendorId: 'ven_tech', assignedVendorName: 'TechSource Nepal',
    estimatedCost: 3500, actualCost: null, resolutionNotes: 'Vendor has collected the unit for bulb replacement.',
    reportedAt: daysAgo(4), resolvedAt: null
  },
  {
    id: 'rep_2', itemId: 'itm_5', itemName: 'Bunsen Burner', locationId: 'loc_scilab', locationName: 'Science Laboratory',
    reportedById: 'usr_4', reportedByName: 'Anita Rai', issue: 'Gas valve cracked during a Grade 9 practical — unsafe to use.',
    priority: 'urgent', status: 'not_repairable', assignedVendorId: null, assignedVendorName: null,
    estimatedCost: null, actualCost: null, resolutionNotes: 'Valve assembly is fused; not cost-effective to repair. Recommend write-off and replacement.',
    reportedAt: daysAgo(21), resolvedAt: daysAgo(19)
  },
  {
    id: 'rep_3', itemId: 'itm_7', itemName: 'Student Desk & Chair Set', locationId: 'loc_6a', locationName: 'Classroom 6A',
    reportedById: 'usr_1', reportedByName: 'Rajesh Shrestha', issue: 'Wobbly leg on one chair, minor repair needed.',
    priority: 'low', status: 'repaired', assignedVendorId: null, assignedVendorName: null,
    estimatedCost: 300, actualCost: 250, resolutionNotes: 'Fixed in-house by the maintenance staff.',
    reportedAt: daysAgo(35), resolvedAt: daysAgo(33)
  }
];

async function run() {
  await db.init();
  await db.save('departments', departments);
  await db.save('users', users);
  await db.save('locations', locations);
  await db.save('categories', categories);
  await db.save('vendors', vendors);
  await db.save('items', items);
  await db.save('conditionLogs', conditionLogs);
  await db.save('transfers', transfers);
  await db.save('procurementRequests', procurementRequests);
  await db.save('repairRequests', repairRequests);

  // -------------------------------------------------------------------------
  // Stock batches (FIFO/LIFO ledger) for a couple of consumable items, so
  // the "Stock Batches" tab has real data to demonstrate the feature.
  // -------------------------------------------------------------------------
  await db.withTx(async conn => {
    // A4 Paper Ream — FIFO — two batches from two different orders
    await db.addStockBatch(conn, { itemId: 'itm_11', itemName: 'A4 Paper Ream', qtyReceived: 25, unitCost: 540, receivedDate: dateAgo(60), vendorId: 'ven_stationery', vendorName: 'Om Stationery Traders', receivedById: 'usr_1', receivedByName: 'Rajesh Shrestha' });
    await db.addStockBatch(conn, { itemId: 'itm_11', itemName: 'A4 Paper Ream', qtyReceived: 15, unitCost: 560, receivedDate: dateAgo(20), vendorId: 'ven_stationery', vendorName: 'Om Stationery Traders', receivedById: 'usr_1', receivedByName: 'Rajesh Shrestha' });
    // Badminton Racket — LIFO — two batches
    await db.addStockBatch(conn, { itemId: 'itm_10', itemName: 'Badminton Racket', qtyReceived: 6, unitCost: 850, receivedDate: dateAgo(150), vendorId: 'ven_sports', vendorName: 'Himalayan Sports House', receivedById: 'usr_1', receivedByName: 'Rajesh Shrestha' });
    await db.addStockBatch(conn, { itemId: 'itm_10', itemName: 'Badminton Racket', qtyReceived: 4, unitCost: 900, receivedDate: dateAgo(45), vendorId: 'ven_sports', vendorName: 'Himalayan Sports House', receivedById: 'usr_1', receivedByName: 'Rajesh Shrestha' });
    // Deduct the difference between total received and current quantity, so
    // remaining batch quantities line up with the item's current stock level.
    await db.deductFromBatches(conn, 'itm_11', 0, 'fifo');   // no-op, keeps 40 remaining
    await db.deductFromBatches(conn, 'itm_10', 6, 'lifo');   // 10 received - 6 issued = 4 remaining, matches item qty

    // Matching purchase log entries (immutable audit trail)
    await db.createPurchaseLog(conn, { id: 'pl_1', itemId: 'itm_11', itemName: 'A4 Paper Ream', procurementId: null, quantity: 25, unit: 'ream', unitCost: 540, totalCost: 13500, receivedAt: daysAgo(60), receivedById: 'usr_1', receivedByName: 'Rajesh Shrestha', vendorId: 'ven_stationery', vendorName: 'Om Stationery Traders', locationId: 'loc_store', locationName: 'Central Store', notes: 'Initial stock order.' });
    await db.createPurchaseLog(conn, { id: 'pl_2', itemId: 'itm_11', itemName: 'A4 Paper Ream', procurementId: null, quantity: 15, unit: 'ream', unitCost: 560, totalCost: 8400, receivedAt: daysAgo(20), receivedById: 'usr_1', receivedByName: 'Rajesh Shrestha', vendorId: 'ven_stationery', vendorName: 'Om Stationery Traders', locationId: 'loc_store', locationName: 'Central Store', notes: 'Top-up order — price increased slightly.' });
    await db.createPurchaseLog(conn, { id: 'pl_3', itemId: 'itm_10', itemName: 'Badminton Racket', procurementId: null, quantity: 6, unit: 'pcs', unitCost: 850, totalCost: 5100, receivedAt: daysAgo(150), receivedById: 'usr_1', receivedByName: 'Rajesh Shrestha', vendorId: 'ven_sports', vendorName: 'Himalayan Sports House', locationId: 'loc_sports', locationName: 'Sports Store', notes: 'Initial sports stock order.' });
    await db.createPurchaseLog(conn, { id: 'pl_4', itemId: 'itm_10', itemName: 'Badminton Racket', procurementId: null, quantity: 4, unit: 'pcs', unitCost: 900, totalCost: 3600, receivedAt: daysAgo(45), receivedById: 'usr_1', receivedByName: 'Rajesh Shrestha', vendorId: 'ven_sports', vendorName: 'Himalayan Sports House', locationId: 'loc_sports', locationName: 'Sports Store', notes: 'Restock ahead of inter-school tournament.' });
  });

  // -------------------------------------------------------------------------
  // Stocking plans — annual budget, weekly order, petty cash allocation
  // -------------------------------------------------------------------------
  await db.insertStockingPlan({ id: 'sp_annual_1', planType: 'annual', title: 'FY 2082/83 Science Department Budget', description: 'Annual equipment and consumables budget for the Science Department.', budget: 250000, departmentId: 'dep_science', departmentName: 'Science Department', fiscalYear: '2082/83', createdById: 'usr_1', createdByName: 'Rajesh Shrestha' });
  await db.insertStockingPlan({ id: 'sp_annual_2', planType: 'annual', title: 'FY 2082/83 IT Department Budget', description: 'Annual budget for computer lab upgrades and licensing.', budget: 400000, departmentId: 'dep_it', departmentName: 'IT / Computer Lab', fiscalYear: '2082/83', createdById: 'usr_1', createdByName: 'Rajesh Shrestha' });
  await db.insertStockingPlan({ id: 'sp_weekly_1', planType: 'weekly', title: 'Week 12 — Central Store Restock', description: 'Regular weekly stationery and cleaning supplies order.', budget: 15000, departmentId: null, departmentName: null, weekNumber: 12, weekStartDate: dateAgo(7), createdById: 'usr_1', createdByName: 'Rajesh Shrestha' });
  await db.insertStockingPlan({ id: 'sp_petty_1', planType: 'petty', title: 'Front Office Petty Cash — Monthly', description: 'Monthly petty cash allocation for day-to-day office needs.', budget: 8000, departmentId: 'dep_admin', departmentName: 'Administration', createdById: 'usr_1', createdByName: 'Rajesh Shrestha' });

  // -------------------------------------------------------------------------
  // Petty cash expenses — a mix of pending and approved, some linked to the
  // petty cash allocation plan above.
  // -------------------------------------------------------------------------
  await db.insertPettyExpense({ id: 'pe_1', description: 'Chalk, dusters and markers for classrooms', amount: 850, category: 'Stationery', paidById: 'usr_1', paidByName: 'Rajesh Shrestha', departmentId: 'dep_admin', departmentName: 'Administration', stockingPlanId: 'sp_petty_1', status: 'approved', expenseDate: dateAgo(15), notes: '' });
  await db.insertPettyExpense({ id: 'pe_2', description: 'Tea and refreshments for parent-teacher meeting', amount: 1200, category: 'Refreshments', paidById: 'usr_1', paidByName: 'Rajesh Shrestha', departmentId: 'dep_admin', departmentName: 'Administration', stockingPlanId: 'sp_petty_1', status: 'approved', expenseDate: dateAgo(10), notes: '' });
  await db.insertPettyExpense({ id: 'pe_3', description: 'Minor plumbing fix in staff washroom', amount: 650, category: 'Repairs', paidById: 'usr_1', paidByName: 'Rajesh Shrestha', departmentId: 'dep_admin', departmentName: 'Administration', stockingPlanId: 'sp_petty_1', status: 'pending', expenseDate: dateAgo(2), notes: 'Awaiting admin approval.' });
  await db.insertPettyExpense({ id: 'pe_4', description: 'Local transport for equipment pickup', amount: 400, category: 'Transport', paidById: 'usr_3', paidByName: 'Bikash Thapa', departmentId: 'dep_it', departmentName: 'IT / Computer Lab', stockingPlanId: null, status: 'pending', expenseDate: dateAgo(1), notes: '' });
  await db.updatePettyExpense('pe_1', { approvedById: 'usr_1', approvedByName: 'Rajesh Shrestha' });
  await db.updatePettyExpense('pe_2', { approvedById: 'usr_1', approvedByName: 'Rajesh Shrestha' });
  await db.withTx(async conn => {
    await db.addSpentToplan(conn, 'sp_petty_1', 850);
    await db.addSpentToplan(conn, 'sp_petty_1', 1200);
  });

  console.log(`Seeded Silver Oak School AssetTrack: ${departments.length} departments, ${users.length} staff, ${locations.length} locations, ${categories.length} categories, ${items.length} items.`);
  console.log('Plus: stock batches (FIFO/LIFO), purchase logs, 4 stocking plans, 4 petty cash expenses.');
  console.log('Admin login: rajesh.shrestha@silveroak.edu.np / Admin@123');
  console.log('Staff login (e.g.): anita.rai@silveroak.edu.np / Welcome@123');
}

run().then(() => {
  console.log('Seed complete.');
  process.exit(0);
}).catch(err => {
  console.error('Seed error:', err);
  process.exit(1);
});
