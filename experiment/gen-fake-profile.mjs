// gen-fake-profile.mjs — write RANDOM fake PII to a local profile file.
// Prints only the KEY names, never the values, so even this test's data
// never enters the orchestrating Claude's context. In real use the USER
// authors profile.local.json by hand and Claude never reads it.
import { writeFileSync } from 'fs';

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const digits = (n) => Math.floor(Math.random() * Math.pow(10, n)).toString().padStart(n, '0');

const names = ['김민준', '이서연', '박지후', '최유나', '정도현', '한지우', '윤서아'];
const cities = [
  '서울특별시 강남구 테헤란로',
  '부산광역시 해운대구 센텀중앙로',
  '경기도 성남시 분당구 판교로',
  '대전광역시 유성구 대학로',
];

const y = 1970 + Math.floor(Math.random() * 35);
const m = String(1 + Math.floor(Math.random() * 12)).padStart(2, '0');
const dd = String(1 + Math.floor(Math.random() * 28)).padStart(2, '0');
const profile = {
  name: pick(names),
  rrn: `${digits(6)}-${digits(7)}`,
  birthdate: `${y}-${m}-${dd}`,
  address: `${pick(cities)} ${1 + Math.floor(Math.random() * 250)}번길 ${1 + Math.floor(Math.random() * 99)}`,
  phone: `010-${digits(4)}-${digits(4)}`,
};

const out = process.argv[2];
if (!out) { console.error('usage: gen-fake-profile.mjs <out.json>'); process.exit(1); }
writeFileSync(out, JSON.stringify(profile, null, 2) + '\n');
console.log('프로필 생성됨 (값 비공개). 포함 키:', Object.keys(profile).join(', '));
