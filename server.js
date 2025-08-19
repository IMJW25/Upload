// server.js
const express = require('express');
const http = require('http');
const socketio = require('socket.io');
const path = require('path');
const xlsx = require('xlsx');

// ====== 모듈 불러오기 ======
const { calcConfirmScores } = require('./ConfirmScore');     // 인증점수 계산 및 저장
const { selectVerifiers } = require('./Confirm');            // 인증점수 기반 검증자 선정
const { processClick, recordClick } = require('./Click');    // 클릭 기록 처리
const { calcPersonalRelScores } = require('./PRelScore');    // 개인 관계 점수 계산
// const { calcRelPairsScores, savePairScores } = require('./RelScore'); // 쌍 점수 계산/저장
// const { saveClickDB } = require('./saveClick');              // 클릭 DB 저장

// ====== 서버 초기화 ======
const app = express();
const server = http.createServer(app);
const io = socketio(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ====== 사용자/검증자 소켓 관리 ======
const userSockets = new Map();      // 지갑주소 → socket.id
const validatorSockets = new Map(); // 검증자 지갑주소 → socket.id

// ====== DB 파일 경로 ======
const NAME_DB_PATH = path.join(__dirname, 'db', 'nameDB.xlsx');
const CHAT_LOGS_PATH = path.join(__dirname, 'db', 'chatLogsDB.xlsx');

// ====== 전역 상태 ======
const nameDB = new Map();               // wallet → nickname
const pendingVerifications = {};        // 후보자별 투표 상태
let validators = [];                    // 현재 뽑힌 검증자 목록

/* ------------------------------------------------------------------ */
/* 📌 1. 유틸: NameDB 로드 */
function loadNameDB() {
  try {
    const wb = xlsx.readFile(NAME_DB_PATH);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const data = xlsx.utils.sheet_to_json(ws, { header: 1 }).slice(1);

    nameDB.clear();
    for (const row of data) {
      const nickname = row[0]?.toString().trim();
      const wallet = row[1]?.toString().toLowerCase().trim();
      if (nickname && wallet) nameDB.set(wallet, nickname);
    }
    console.log('✅ nameDB 로드 완료:', nameDB.size);
  } catch (err) {
    console.error('❌ nameDB 로드 오류:', err);
  }
}
loadNameDB();
// 서버 시작될 때 지갑주소를 가진 사용자의 닉네임 조회하게 준비하는 함수
/* ------------------------------------------------------------------ */
/* 📌 2. 유틸: 채팅 로그 읽기/쓰기 */
function loadChatLogs() {
  try {
    const wb = xlsx.readFile(CHAT_LOGS_PATH);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const data = xlsx.utils.sheet_to_json(ws, { header: 1 }).slice(1);
    return data.map(row => ({
      fromUser: row[0],
      toUser: row[1],
      message: row[2]
    }));
  } catch (err) {
    console.error('❌ 채팅 로그 로드 오류:', err);
    return [];
  }
}

function saveChatLog({ fromUser, message }) {
  try {
    const wb = xlsx.readFile(CHAT_LOGS_PATH);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const arr = xlsx.utils.sheet_to_json(ws, { header: 1 });
    arr.push([fromUser, '', message]);
    const newWs = xlsx.utils.aoa_to_sheet(arr);
    wb.Sheets[wb.SheetNames[0]] = newWs;
    xlsx.writeFile(wb, CHAT_LOGS_PATH);
    console.log(`💾 채팅 로그 저장: ${fromUser} -> ${message}`);
  } catch (err) {
    console.error('❌ 채팅 로그 저장 오류:', err);
  }
}

/* ------------------------------------------------------------------ */
/* 📌 3. REST API */
app.get('/users', (req, res) => {
  console.log('📡 /users 요청됨');
  res.json(Array.from(userSockets.keys()));
});

app.post('/api/approveUser', (req, res) => {
  const { candidate, nickname, approvers, link } = req.body;
  console.log('📡 /api/approveUser 호출:', { candidate, nickname, approvers, link });
  
  if (!candidate || !nickname || !Array.isArray(approvers) || !link) {
    return res.status(400).json({ error: '잘못된 요청 데이터' });
  }

  processClick(candidate, nickname, 'profileLinkPlaceholder');
  approvers.forEach(validator => recordClick(validator, candidate, link));

  console.log(`사용자 ${candidate} 승인 및 클릭 기록 저장 완료`);
  res.json({ status: 'success' });
});

/* ------------------------------------------------------------------ */
/* 📌 4. Socket.IO 이벤트 처리 */
io.on('connection', (socket) => {
  console.log(`클라이언트 연결됨: ${socket.id}`);

  // ==== 4-1. 기존 사용자 등록 ====
  socket.on('registerUser', async ({ walletAddr, nickname }) => {
    console.log('🟢 registerUser 이벤트 수신:', { walletAddr, nickname });
    const normalizedWallet = walletAddr.toLowerCase();
    // TODO: checkUserExistsInNameDB 구현 필요
    const isExistingUser = nameDB.has(normalizedWallet);

    userSockets.set(normalizedWallet, { socketId: socket.id, nickname });
    if (isExistingUser) {
      console.log(`기존 사용자 등록: ${walletAddr} (${nickname})`);
      socket.emit('existingUserConfirmed', { walletAddr: normalizedWallet, nickname });
    } else {
      console.log(`신규 사용자 등록: ${walletAddr} (${nickname})`);
    }
  });

  // ==== 4-2. 채팅 ====
  const logs = loadChatLogs();
  socket.emit('chatLogs', logs);

  socket.on('sendMessage', ({ fromUser, message }) => {
      console.log('💬 sendMessage 이벤트:', { fromUser, message });
      saveChatLog({ fromUser, message });
      const toSocketInfo = userSockets.get(fromUser.toLowerCase());
      if (toSocketInfo) io.to(toSocketInfo.socketId).emit('receiveMessage', { fromUser, message });
      
      // 원래 있던 잘못된 참조 삭제
      // if (toSocket) io.to(toSocket).emit('receiveMessage', { fromUser, message });

      socket.emit('receiveMessage', { fromUser, message });
  });

  // ==== 4-3. 링크 업로드 ====
  socket.on('newLink', async ({ link, wallet }) => {
    console.log('🔗 newLink 이벤트:', { link, wallet });
    const nickname = nameDB.get(wallet.toLowerCase());
    if (!nickname) return console.log(`❌ 닉네임 없음: ${wallet}`);

    const prel = calcPersonalRelScores();
    const userScore = prel[nickname] || 0;
    console.log(`📊 사용자 점수 (${nickname}):`, userScore);

    if (userScore >= 0.5) {
      io.emit('newLink', { link, fromUser: nickname });
      console.log(`✅ 메시지 브로드캐스트: ${nickname}`);
    } else {
      console.log(`❌ 점수 부족으로 메시지 차단: ${nickname}`);
    }
  });

  // ==== 4-4. 링크 클릭 ====
  socket.on('linkClicked', async ({ fromUser, toUser, link }) => {
    console.log(`🖱️ linkClicked: ${fromUser} -> ${toUser} | ${link}`);
    const prel = calcPersonalRelScores();
    const rel = calcRelPairsScores();
    savePairScores(rel);

    const score = prel[fromUser] || 0;
    console.log(`📊 ${fromUser} 점수:`, score);
    const toSocketInfo = userSockets.get(toUser.toLowerCase());

    if (score >= 0.5) {
        console.log(`✅ 접근 허용: ${toUser} -> ${fromUser}`);
        if (toSocketInfo) io.to(toSocketInfo.socketId).emit('linkAccessGranted', { fromUser, link });
    } else {
        console.log(`❌ 접근 거부: ${toUser} -> ${fromUser}`);
        if (toSocketInfo) io.to(toSocketInfo.socketId).emit('linkAccessDenied', { fromUser, link, reason: '점수 미달' });
    }
  });

  // ==== 4-5. 신규 사용자 입장 요청 ====
  socket.on('requestEntry', async ({ wallet, nickname }) => {
    console.log('🚪 requestEntry 이벤트:', { wallet, nickname });
    const candidate = wallet.toLowerCase();
    if (pendingVerifications[candidate]) return;

    await calcConfirmScores();
    validators = selectVerifiers();
    console.log('🧑‍⚖️ 선정된 검증자 목록:', validators);

    pendingVerifications[candidate] = {
      validators: validators.map(v => v.id),
      votes: {},
      nickname,
      link: ''
    };
    console.log('📝 대기중인 검증 요청:', pendingVerifications[candidate]);

    for (const vAddr of pendingVerifications[candidate].validators) {
      const vSocketId = validatorSockets.get(vAddr.toLowerCase());
      if (vSocketId) {
        io.to(vSocketId).emit('verificationRequested', {
          candidate, nickname,
          message: `${nickname}(${candidate}) 님이 입장 요청`,
          validators: pendingVerifications[candidate].validators
        });
        console.log(`📩 검증 요청 전송 → ${vAddr}`);
      }
    }
  });

  // ==== 4-6. 투표 ====
  socket.on('vote', ({ candidate, verifier, approve }) => {
    console.log('🗳️ vote 이벤트:', { candidate, verifier, approve });
    verifier = verifier.toLowerCase();
    const data = pendingVerifications[candidate];
    if (!data || data.votes[verifier] !== undefined) return;

    data.votes[verifier] = !!approve;
    console.log(`📊 현재 투표 현황:`, data.votes);

    if (Object.keys(data.votes).length === data.validators.length) {
      console.log(`⚖️ 모든 투표 완료 → 검증 진행`);
      finalizeVerification(candidate);
    }
  });

  // ==== 4-7. 연결 종료 ====
  socket.on('disconnect', () => {
  console.log(`🔌 disconnect 이벤트: ${socket.id}`);

  for (const [wallet, info] of userSockets.entries()) {
    if (info.socketId === socket.id) {
      console.log(`임시 해제: ${wallet} (${socket.id})`);
      userSockets.set(wallet, { ...info, socketId: null });  // ✅ 삭제 안 하고 socketId만 null
    }
  }

  for (const [v, id] of validatorSockets.entries()) {
    if (id === socket.id) {
      console.log(`검증자 임시 해제: ${v}`);
      validatorSockets.set(v, null);                         // ✅ 삭제 대신 null
    }
  }
  });

});

/* ------------------------------------------------------------------ */
/* 📌 5. 검증 최종 처리 */
function finalizeVerification(candidate) {
    console.log('⚖️ finalizeVerification 호출:', candidate);
    const data = pendingVerifications[candidate];
    if (!data) return;

    const approvals = Object.values(data.votes).filter(v => v).length;
    const total = data.validators.length;
    const approved = approvals * 3 >= total * 2; // 2/3 이상 찬성

    if (approved) console.log(`✅ ${candidate} 승인 (${approvals}/${total})`);
    else console.log(`❌ ${candidate} 거절 (${approvals}/${total})`);

    const socketInfo = userSockets.get(candidate);
    if (socketInfo) {
      console.log(`📩 검증 결과 전송 → 후보자 ${candidate}`);
      io.to(socketInfo.socketId).emit('verificationCompleted', { candidate, approved });
    }

    data.validators.forEach(v => {
        const vId = validatorSockets.get(v.toLowerCase());
        if (vId) {
          console.log(`📩 검증 결과 전송 → 검증자 ${v}`);
          io.to(vId).emit('verificationResult', { candidate, approved });
        }
    });

    delete pendingVerifications[candidate];
    console.log(`🗑️ 검증 요청 제거: ${candidate}`);
  }

/* ------------------------------------------------------------------ */
// 서버 실행
const PORT = 3000;
server.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
});
