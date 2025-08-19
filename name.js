// name.js
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const NAME_DB_PATH = path.join(__dirname, 'db', 'nameDB.xlsx');

// 신규 사용자 정보를 nameDB.xlsx에 저장
function saveNewUser({ nickname, wallet }) {
  try {
    let wb, ws, data;

    // 엑셀 파일이 있는지 확인
    if (fs.existsSync(NAME_DB_PATH)) {
      wb = XLSX.readFile(NAME_DB_PATH);
      ws = wb.Sheets[wb.SheetNames[0]];
      data = XLSX.utils.sheet_to_json(ws, { header: 1 });
    } else {
      // 파일이 없으면 새 워크북·시트 생성 및 헤더 설정
      wb = XLSX.utils.book_new();
      data = [['Nickname', 'Wallet']];
      ws = XLSX.utils.aoa_to_sheet(data);
      XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    }

    // 기존에 동일한 wallet이 있는지 체크
    const existing = data.slice(1).some(row => 
      row[1]?.toString().toLowerCase().trim() === wallet.toLowerCase().trim()
    );
    if (existing) {
      console.log(`🔍 [name.js] 이미 등록된 지갑: ${wallet}`);
      return false;
    }

    // 새 사용자 행 추가
    data.push([nickname, wallet.toLowerCase()]);

    // 시트 업데이트 및 파일 저장
    const newWs = XLSX.utils.aoa_to_sheet(data);
    wb.Sheets[wb.SheetNames[0]] = newWs;
    XLSX.writeFile(wb, NAME_DB_PATH);

    console.log(`✅ [name.js] 신규 사용자 저장: ${nickname} (${wallet})`);
    return true;
  } catch (err) {
    console.error('❌ [name.js] 신규 사용자 저장 오류:', err);
    return false;
  }
}

// 모듈로 내보내기
module.exports = { saveNewUser };

// 단독 실행 시 테스트
if (require.main === module) {
  // 예시 사용자
  const success = saveNewUser({
    nickname: 'NewUser',
    wallet: '0xabcdef1234567890abcdef1234567890abcdef12'
  });
  console.log('저장 결과:', success);
}
