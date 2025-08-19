// front.js

// 서버와 socket.io 연결
const socket = io();

// 사용자 지갑 주소(로컬 스토리지 등에서 불러오기)
let walletAddress = localStorage.getItem('walletAddress') || '';
let nickname = localStorage.getItem('userId') || '';

/**
 * page1에서 '입장하기' 버튼 클릭 시 호출할 함수
 * 서버에 신규 사용자 입장 요청을 보냄
 */
function requestEntry() {
  if (!walletAddress) {
    alert('먼저 지갑을 연결하세요');
    return;
  }
  if (!nickname) {
    alert('닉네임을 입력하세요');
    return;
  }
  // 서버에 입장 요청 전송
  socket.emit('requestEntry', { wallet: walletAddress, nickname: nickname });
}

/**
 * 서버로부터 'verificationCompleted' 이벤트를 수신했을 때 처리 함수
 * 승인 여부에 따라 페이지 이동 또는 알림 띄움
 */
socket.on('verificationCompleted', (data) => {
  if (data.candidate.toLowerCase() === walletAddress.toLowerCase()) {
    if (data.approved) {
      // 2/3 이상 승인 시 page2.html로 이동
      window.location.href = 'page2.html';
    } else {
      // 승인이 거절되었을 때 알림
      alert('승인되지 않았습니다.');
      // 필요시 입력창 초기화 등의 후속 조치 가능
    }
  }
});

/**
 * page2에서 '찬성' 또는 '반대' 투표 버튼 클릭 시 호출할 함수 (예시)
 */
function submitVote(candidate, isApprove) {
  if (!walletAddress) {
    alert('지갑을 연결해야 투표할 수 있습니다.');
    return;
  }
  if (!candidate) {
    alert('투표할 신규 사용자 주소를 입력하세요');
    return;
  }
  // 서버에 투표 정보 전송
  socket.emit('submitVote', {
    candidate: candidate.toLowerCase(),
    validator: walletAddress.toLowerCase(),
    approve: isApprove,
  });
}

// 예: 투표 버튼 이벤트 리스너 예시 방식

document.getElementById('approveBtn')?.addEventListener('click', () => {
  const candidate = document.getElementById('candidateInput')?.value.trim().toLowerCase();
  submitVote(candidate, true);
});

document.getElementById('rejectBtn')?.addEventListener('click', () => {
  const candidate = document.getElementById('candidateInput')?.value.trim().toLowerCase();
  submitVote(candidate, false);
});
