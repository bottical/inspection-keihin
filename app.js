// 検品ページの流れ
// 1) pickingId入力→ onSnapshot で対象ドキュメントを一度だけ購読し、currentPickingData に最新内容を保持
// 2) scanBarcode は currentPickingData を参照してローカルで検品処理→ Firestore には update のみを送信
// 3) 別IDへ切り替える際は以前の購読を unsubscribe してローカル状態をクリア

// Firebaseの設定
const firebaseConfig = {
    apiKey: "AIzaSyDRBbgFWc0Tlf9UZrJOmQXeW4LBdxHVRWI",
    authDomain: "inspection-keihin.firebaseapp.com",
    projectId: "inspection-keihin",
    storageBucket: "inspection-keihin.firebasestorage.app",
    messagingSenderId: "127263387872",
    appId: "1:127263387872:web:768593c8aeb8694f39a085"
};

let currentBatchId = null;
let currentPickingId = null; // 現在のピッキングIDを格納
let currentPickingData = null; // onSnapshot で購読した最新のピッキングデータ
let currentPickingUnsubscribe = null; // 購読解除用関数
let currentPickingDocRef = null; // 現在購読しているドキュメント参照
let lastVisibleBatchDoc = null; // ページング用カーソル
let currentBatchQueryMode = "latest"; // "latest" | "dateRange"
let currentBatchDateRange = { start: null, end: null }; // 検索期間
const BATCH_PAGE_SIZE = 20; // 1ページあたりの件数

// Firebaseを初期化
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
const auth = firebase.auth();

// ログインユーザーのIDを取得する関数
function getCurrentUserId() {
    const user = auth.currentUser;
    return user ? user.uid : null;
}

// Firestoreデータ操作でユーザー情報を含める例
function saveDataWithUser(data) {
    const userId = getCurrentUserId();
    if (!userId) {
        alert("ログインが必要です。");
        return;
    }

    db.collection("SomeCollection").add({
        ...data,
        userId: userId,
        timestamp: firebase.firestore.FieldValue.serverTimestamp(),
    })
    .then(() => {
        alert("データ保存に成功しました！");
    })
    .catch((error) => {
        console.error("データ保存失敗:", error);
        alert("データ保存中にエラーが発生しました。");
    });
}


const clientSettings = {
    clientA: {
        picking_id: 0,
        item_id: 1,
        item_name: 4,
        item_quantity: 7,
        item_barcode: 16,
        recipient_name: 2, // 届け先氏名
        shipment_date: 3, // 出荷作業日
        ins_flg: 0,
        lot_number: 3
    },
    clientB: {
        picking_id: 1,
        user_id: 2,
        item_id: 0,
        item_quantity: 3,
        item_barcode: 4,
        recipient_name: 5, // 届け先氏名
        shipment_date: 20, // 発送日
        created_at: 3
    }
    // 他のクライアントの設定も同様に追加
};

// 日付をフォーマットする関数 (YYYYMMDD形式)
function getFormattedDate() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `${year}${month}${day}`;
}

function getJstDateParts(date) {
    const formatter = new Intl.DateTimeFormat("ja-JP", {
        timeZone: "Asia/Tokyo",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    });
    const parts = formatter.formatToParts(date).reduce((acc, part) => {
        if (part.type !== "literal") {
            acc[part.type] = part.value;
        }
        return acc;
    }, {});
    return {
        year: Number(parts.year),
        month: Number(parts.month),
        day: Number(parts.day)
    };
}

function formatDateInput(date) {
    const { year, month, day } = getJstDateParts(date);
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// ==== インポート中の離脱防止処理 ====
let isImporting = false; // インポート処理中フラグ

// ページ離脱時に警告を出す
window.addEventListener("beforeunload", function (e) {
  if (isImporting) {
    e.preventDefault();
    e.returnValue = "インポート処理がまだ完了していません。本当にページを離れますか？";
  }
});

// 既存の importCSV を拡張
function importCSV() {
  if (isImporting) {
    alert("すでにインポート中です。");
    return;
  }
  isImporting = true;

  const fileInput = document.getElementById("csvFileInput").files[0];
  if (!fileInput) {
    alert("CSVファイルを選択してください。");
    isImporting = false;
    return;
  }

  // 使用するクライアントを選択（例としてclientAを使用）
  const currentClient = clientSettings.clientA;

  const encoding = document.querySelector('input[name="encoding"]:checked').value;
  const reader = new FileReader();

  reader.onload = function (event) {
    try {
      const uint8Array = new Uint8Array(event.target.result);
      const text = new TextDecoder(encoding).decode(uint8Array);
      // parseCSV 内の Promise チェーンの finally で isImporting が false になります
      parseCSV(text, currentClient);
    } catch (e) {
      console.error("CSV解析中に例外:", e);
      alert("CSVの解析中にエラーが発生しました。");
      isImporting = false; // ここでも必ず解除
    }
  };

  reader.onerror = function (e) {
    console.error("CSVファイル読込エラー:", e);
    alert("CSVファイルの読み込みに失敗しました。");
    isImporting = false; // 読込失敗でも解除
  };

  reader.readAsArrayBuffer(fileInput); // ArrayBufferとして読み込む
}

function sanitizePickingIdForFirestore(pickingId) {
  return pickingId.replaceAll("/", "__");
}

function desanitizePickingIdFromFirestore(safeId) {
  return safeId.replaceAll("__", "/");
}

// picking_id を picking_id/item_id（2桁ゼロ埋め）に統合した parseCSV
function parseCSV(text, clientConfig) {
  const includeHeader = document.getElementById("includeHeader").checked;
  const csvBatchId = getFormattedTimestamp();

  text = text.replace(/"(.*?)"/gs, (match) => {
    return match.replace(/\n/g, " ");
  });

  let rows = text.split("\n");
  const startIndex = includeHeader ? 1 : 0;

  const pickingsData = {};
  const importDate = getFormattedDate();

  for (let i = startIndex; i < rows.length; i++) {
    const row = rows[i].trim();
    if (!row) continue;

    const columns = row
      .split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/)
      .map(col => col.replace(/^"|"$/g, ''));

    const basePickingId = columns[clientConfig.picking_id] || `UNKNOWN_${i}`;
    const itemIdRaw    = columns[clientConfig.item_id] || "0";
    const itemIdPadded = itemIdRaw.toString().padStart(2, "0");

    // 表示用（/あり）と Firestore用（/→__）を分ける
    const pickingIdOriginal = `${basePickingId}/${itemIdPadded}`;
    const pickingId = sanitizePickingIdForFirestore(pickingIdOriginal);

    let insFlg = parseInt(columns[clientConfig.ins_flg] || "0", 10);
    const barcode = columns[clientConfig.item_barcode] || "NO_BARCODE";
    if (barcode === "NO_BARCODE") insFlg = 2;
    const isExcluded = insFlg === 2;

    const taxIncludedPrice = parseFloat(columns[5] || "0");
    const taxRate = parseFloat(columns[6] || "0");
    const unitPrice = Math.ceil(taxIncludedPrice / (1 + taxRate));

    function flagTransform(value) {
      return value === "あり" ? "◯" : "✕";
    }
    function noshiTransform(value) {
      if (value === "外熨斗") return "外";
      if (value === "内熨斗") return "内";
      return "-";
    }

    const itemData = {
      item_id: itemIdRaw,
      item_name: columns[clientConfig.item_name] || "不明な商品",
      quantity: parseInt(columns[clientConfig.item_quantity] || "0", 10),
      barcode: barcode,
      ins_flg: insFlg,
      lot_number: unitPrice + "円",
      item_status: isExcluded,
      scanned_count: isExcluded ? parseInt(columns[clientConfig.item_quantity] || "0", 10) : 0,

      wrapping_flag: flagTransform(columns[8]),
      noshi_flag: flagTransform(columns[9]),
      paper_flag: flagTransform(columns[10]),
      short_strip_flag: flagTransform(columns[11]),
      noshi_type: noshiTransform(columns[12]),
      fresh_flag: flagTransform(columns[13]),
      bag_flag: flagTransform(columns[14]),
      message_flag: flagTransform(columns[15])
    };

    if (pickingsData[pickingId]) {
      pickingsData[pickingId].items.push(itemData);
    } else {
      pickingsData[pickingId] = {
        picking_id: pickingIdOriginal,
        user_id: getCurrentUserId() || "UNKNOWN_USER",
        recipient_name: columns[clientConfig.recipient_name] || "不明な受取人",
        shipment_date: importDate,
        csv_batch_id: csvBatchId,
        items: [itemData],
        status: false,
        created_at: firebase.firestore.FieldValue.serverTimestamp()
      };
    }
  }

  const totalPickings = Object.keys(pickingsData).length;

  // ★★★ Promise.all は「parseCSV の中の末尾」に置くのが正解 ★★★
  Promise.all(
    Object.entries(pickingsData).map(([pickingId, data]) => {
      return db.collection("Pickings").doc(pickingId).set(data)
        .then(() => console.log(`登録成功: ${pickingId}`))
        .catch(error => console.error(`登録失敗: ${pickingId}`, error));
    })
  )
  .then(() => {
    return db.collection("BatchInfo").doc(csvBatchId).set({
      csv_batch_id: csvBatchId,
      total_pickings: totalPickings,
      completed_pickings: 0,
      created_at: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  })
  .then(() => {
    console.log("インポート完了");
    alert("インポートが完了しました！");
  })
  .catch((error) => {
    console.error("インポートエラー:", error);
    alert("インポート中にエラーが発生しました。");
  })
  .finally(() => {
    isImporting = false; // どの経路でも必ず解除
  });
}


// CSVバッチIDを作成 (例: 20240203-153045)
function getFormattedTimestamp() {
    const now = new Date();
    return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
}


document.addEventListener("DOMContentLoaded", function () {
    // Firebase Auth のインスタンス確認
    if (!auth) {
        console.error("Firebase Authenticationが初期化されていません。");
        return;
    }

    // ログインボタンのイベントリスナー
    const loginButton = document.getElementById("loginButton");
    if (loginButton) {
        loginButton.addEventListener("click", () => {
            const email = document.getElementById("emailInput")?.value.trim();
            const password = document.getElementById("passwordInput")?.value.trim();

            if (!email || !password) {
                alert("メールアドレスとパスワードを入力してください。");
                return;
            }

            // ログイン状態の永続性を設定
            auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL)
                .then(() => auth.signInWithEmailAndPassword(email, password))
                .then((userCredential) => {
                    console.log(`ログイン成功: ${userCredential.user.email}`);
                    alert("ログインしました！");
                })
                .catch((error) => {
                    console.error("ログイン失敗:", error);
                    alert(`ログイン失敗: ${error.message}`);
                });
        });
    } else {
        console.warn("ログインボタン（#loginButton）が見つかりません。");
    }

    // ログアウトボタンのイベントリスナー
    const logoutButton = document.getElementById("logoutButton");
    if (logoutButton) {
        logoutButton.addEventListener("click", () => {
            auth.signOut()
                .then(() => {
                    console.log("ログアウト成功");
                    alert("ログアウトしました。");
                })
                .catch((error) => {
                    console.error("ログアウト失敗:", error);
                });
        });
    } else {
        console.warn("ログアウトボタン（#logoutButton）が見つかりません。");
    }

    // ページ識別用属性（例: <body data-page="inspection">）
    const pageType = document.body.getAttribute("data-page");
    if (!pageType) {
        console.error("ページ識別のための 'data-page' 属性が見つかりません。");
        return;
    }

    // ログイン状態の監視（全ページ共通）
    auth.onAuthStateChanged((user) => {
        const welcomeMessage = document.getElementById("welcomeMessage");
        const loginContainer = document.getElementById("loginContainer");
        const userInfo = document.getElementById("userInfo");
        const logoutButton = document.getElementById("logoutButton");

        if (user) {
            console.log(`ログイン中: ${user.email}`);
            if (welcomeMessage) welcomeMessage.textContent = `ようこそ、${user.email} さん`;
            if (loginContainer) loginContainer.style.display = "none";
            if (userInfo) userInfo.style.display = "block";
            if (logoutButton) logoutButton.style.display = "block";
        } else {
            console.log("ログアウト状態");
            if (welcomeMessage) welcomeMessage.textContent = "";
            if (loginContainer) loginContainer.style.display = "block";
            if (userInfo) userInfo.style.display = "none";
            if (logoutButton) logoutButton.style.display = "none";
        }

        if (pageType === "registration") {
            handleRegistrationAuthState(user);
        }
    });

    // ページごとの処理
    if (pageType === "inspection") {
        setupInspectionPage();
    } else if (pageType === "registration") {
        setupRegistrationPage();
    } else {
        console.log("特定のページ固有の処理はありません。");
    }
});


// 検品ページの初期化関数
function setupInspectionPage() {
    console.log("検品ページのセットアップ開始");

    const pickingIdInput = document.getElementById("pickingIdInput");
    if (pickingIdInput) {
        pickingIdInput.addEventListener("keydown", function (event) {
            if (event.key === "Enter") {
                console.log("Enterキーが押されました: pickingIdInput");
                fetchPickingData();
            }
        });
    } else {
        console.warn("Element with ID 'pickingIdInput' not found. 検品ページに必要な要素が不足しています。");
    }

    const barcodeInput = document.getElementById("barcodeInput");
    if (barcodeInput) {
        barcodeInput.addEventListener("keydown", function (event) {
            if (event.key === "Enter") {
                console.log("Enterキーが押されました: barcodeInput");
                scanBarcode();
            }
        });
    } else {
        console.warn("Element with ID 'barcodeInput' not found. 検品ページに必要な要素が不足しています。");
    }
}

// 登録ページの初期化関数
function setupRegistrationPage() {
    console.log("登録ページのセットアップ開始");

    const batchSearchButton = document.getElementById("batchSearchButton");
    if (batchSearchButton) {
        batchSearchButton.addEventListener("click", () => {
            performDateSearch();
        });
    }

    const batchTodayButton = document.getElementById("batchTodayButton");
    if (batchTodayButton) {
        batchTodayButton.addEventListener("click", () => {
            const today = new Date();
            setDateRangeAndSearch(today, today);
        });
    }

    const batchYesterdayButton = document.getElementById("batchYesterdayButton");
    if (batchYesterdayButton) {
        batchYesterdayButton.addEventListener("click", () => {
            const today = new Date();
            const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
            setDateRangeAndSearch(yesterday, yesterday);
        });
    }

    const batchLast7DaysButton = document.getElementById("batchLast7DaysButton");
    if (batchLast7DaysButton) {
        batchLast7DaysButton.addEventListener("click", () => {
            const today = new Date();
            const start = new Date(today.getTime() - 6 * 24 * 60 * 60 * 1000);
            setDateRangeAndSearch(start, today);
        });
    }

    const batchLatestButton = document.getElementById("batchLatestButton");
    if (batchLatestButton) {
        batchLatestButton.addEventListener("click", () => {
            currentBatchQueryMode = "latest";
            currentBatchDateRange = { start: null, end: null };
            const startInput = document.getElementById("batchStartDate");
            const endInput = document.getElementById("batchEndDate");
            if (startInput) startInput.value = "";
            if (endInput) endInput.value = "";
            loadBatchList({ mode: "latest", append: false });
        });
    }

    const batchShowMoreButton = document.getElementById("batchShowMoreButton");
    if (batchShowMoreButton) {
        batchShowMoreButton.addEventListener("click", () => {
            loadBatchList({
                mode: currentBatchQueryMode,
                dateRange: currentBatchDateRange,
                append: true
            });
        });
    }

    const progressCheckButton = document.getElementById("progressCheckButton");
    if (progressCheckButton) {
        progressCheckButton.addEventListener("click", () => {
            console.log("進捗確認ボタンが押されました");
            currentBatchQueryMode = "latest";
            currentBatchDateRange = { start: null, end: null };
            loadBatchList({ mode: "latest", append: false });
        });
    }
}

function handleRegistrationAuthState(user) {
    const batchListContainer = document.getElementById("batchListContainer");
    if (!batchListContainer) {
        return;
    }

    const batchShowMoreButton = document.getElementById("batchShowMoreButton");

    if (user) {
        currentBatchQueryMode = "latest";
        currentBatchDateRange = { start: null, end: null };
        loadBatchList({ mode: "latest", append: false });
        return;
    }

    batchListContainer.innerHTML = "<p>ログインしてください。</p>";
    if (batchShowMoreButton) {
        batchShowMoreButton.style.display = "none";
    }
}

// 日付をフォーマットする関数
function formatShipmentDate(shipmentDate) {
    if (!shipmentDate || shipmentDate.length !== 8) {
        return "不明"; // 不正な日付の場合
    }

    const year = shipmentDate.slice(0, 4); // 年
    const month = shipmentDate.slice(4, 6); // 月
    const day = shipmentDate.slice(6, 8); // 日

    return `${year}年${parseInt(month, 10)}月${parseInt(day, 10)}日`; // フォーマット後の文字列
}

// ピッキングIDでデータを取得して表示（onSnapshot のみで購読）
function fetchPickingData() {
    const pickingIdInput = document.getElementById("pickingIdInput");
    let pickingIdRaw = pickingIdInput.value.trim();

    if (!pickingIdRaw) {
        playSound('error.mp3', () => {
            alert("ピッキングIDを入力してください。");
        });
        return;
    }

    // 🔽 11桁以上なら先頭の11桁を取得し、先頭の0を除去
    if (pickingIdRaw.length >= 11) {
        pickingIdRaw = pickingIdRaw.slice(0, 11).replace(/^0+/, '');
        console.log(`11桁取得後、先頭の0を除去したピッキングID: ${pickingIdRaw}`);
    }

    // 🔽 Firestore用に変換（/ → __）
    const sanitizedId = sanitizePickingIdForFirestore(pickingIdRaw);

    // 異なるIDなら前の検品データをリセット
    if (currentPickingId && currentPickingId !== sanitizedId) {
        resetScannedCount(currentPickingId);
    }

    // 既存の購読を解除し、ローカル状態を初期化
    if (currentPickingUnsubscribe) {
        currentPickingUnsubscribe();
        currentPickingUnsubscribe = null;
    }

    currentPickingId = sanitizedId;
    currentPickingData = null;
    currentPickingDocRef = db.collection("Pickings").doc(currentPickingId);

    let isFirstSnapshot = true;

    currentPickingUnsubscribe = currentPickingDocRef.onSnapshot(
        (doc) => {
            if (!doc.exists) {
                if (isFirstSnapshot) {
                    playSound('error.mp3', () => {
                        alert("該当するピッキングIDが見つかりませんでした。");
                    });
                }
                currentPickingId = null;
                currentPickingData = null;
                if (currentPickingUnsubscribe) {
                    currentPickingUnsubscribe();
                    currentPickingUnsubscribe = null;
                }

                document.getElementById("currentPickingIdDisplay").textContent = "";
                document.getElementById("recipientNameDisplay").textContent = "届け先氏名: 不明";
                document.getElementById("shipmentDateDisplay").textContent = "発送日: 不明";
                pickingIdInput.focus();
                return;
            }

            const data = doc.data();

            // --- items を必ず「配列」に正規化し、必要な項目をマージ ---
            let normalizedItems = [];

            if (Array.isArray(data.items)) {
                // 新スキーマ：すでに配列
                normalizedItems = data.items;
            } else if (data.items && typeof data.items === "object") {
                // items が map（0,1,2キーなど）のケース
                normalizedItems = Object.values(data.items).map((subItem, index) => ({
                    ...data,
                    ...subItem,
                    item_id: subItem.item_id || String(index + 1),
                }));
            } else {
                // 完全な旧スキーマ：items フィールド自体が無い
                normalizedItems = [{
                    ...data,
                    item_id: data.item_id || "1",
                }];
            }

            // 正規化した items を保持
            currentPickingData = { ...data, items: normalizedItems };

            // 初回のみ「すでに検品済み」を弾く
            if (data.status === true && isFirstSnapshot) {
                playSound('error.mp3', () => {
                    alert("このピッキングIDはすでに検品済みです。");
                });
                currentPickingId = null;
                currentPickingData = null;
                if (currentPickingUnsubscribe) {
                    currentPickingUnsubscribe();
                    currentPickingUnsubscribe = null;
                }
                document.getElementById("currentPickingIdDisplay").textContent = "";
                document.getElementById("recipientNameDisplay").textContent = "届け先氏名: 不明";
                document.getElementById("shipmentDateDisplay").textContent = "発送日: 不明";
                pickingIdInput.focus();
                return;
            }

            if (isFirstSnapshot) {
                playSound('success.mp3'); // 初回ロード成功音
            }

            displayItemList(normalizedItems);

            document.getElementById("currentPickingIdDisplay").textContent =
                `現在検品中のピッキングID: ${data.picking_id || desanitizePickingIdFromFirestore(currentPickingId)}`;

            document.getElementById("recipientNameDisplay").textContent =
                `届け先氏名: ${data.recipient_name || "未設定"}`;
            document.getElementById("shipmentDateDisplay").textContent =
                `発送日: ${formatShipmentDate(data.shipment_date)}`;

            document.getElementById("barcodeInput").focus();
            isFirstSnapshot = false;
        },
        (error) => {
            playSound('error.mp3', () => {
                alert("エラーが発生しました。");
            });
            console.error("onSnapshot エラー:", error);
            currentPickingId = null;
            currentPickingData = null;
            if (currentPickingUnsubscribe) {
                currentPickingUnsubscribe();
                currentPickingUnsubscribe = null;
            }
            pickingIdInput.focus();
        }
    );

    // 入力欄はとりあえずクリア
    pickingIdInput.value = "";
}


// スキャン済みカウントをリセット（既存ロジックを維持）
function resetScannedCount(pickingIdRaw) {
    const pickingId = sanitizePickingIdForFirestore(pickingIdRaw);

    db.collection("Pickings").doc(pickingId).get()
        .then((doc) => {
            if (doc.exists) {
                const data = doc.data();

                if (data.status === true) {
                    console.log(`ピッキングID ${desanitizePickingIdFromFirestore(pickingId)} は既に検品済みのためリセットをスキップします。`);
                    return;
                }

                const resetItems = data.items.map((item) => {
                    item.scanned_count = 0;
                    item.item_status = false;
                    return item;
                });

                return db.collection("Pickings").doc(pickingId).update({
                    items: resetItems,
                    status: false
                }).then(() => {
                    console.log(`ピッキングID ${desanitizePickingIdFromFirestore(pickingId)} の検品データをリセットしました。`);
                });
            }
        })
        .catch((error) => {
            console.error("scanned_countのリセット中にエラーが発生しました:", error);
        });
}





function createItemElement(item) {
    const scanned = item.scanned_count ?? 0;
    const quantity = item.quantity ?? 1;

    const barcode = item.barcode || "";
    const barcodePrefix = barcode.slice(0, -4);
    const barcodeSuffix = barcode.slice(-4);

    const listItem = document.createElement("li");
    listItem.id = `item-${item.item_id}`;
    listItem.className = item.item_status ? "complete" : "";

    const statusText = item.ins_flg === 2
    ? "検品対象外"
    : item.item_status
        ? "完了"
        : scanned > 0
            ? "検品中"
            : "未検品";

    const statusClass = statusText;

    listItem.innerHTML = `
        <div style="display: contents;">
            <div style="font-size: 1.2em;">${item.item_name}</div>
            <div>${item.lot_number}</div>
            <div><span>${barcodePrefix}</span><span class="barcode-suffix">${barcodeSuffix}</span></div>
            <div class="status ${statusClass}">${statusText}</div>
            <div style="font-size: 1.5em;">${scanned}/${quantity}</div>
        </div>
        <div style="grid-column: 1 / -1; font-size: 1.1em; color: #666; padding-top: 5px; padding-left: 10px;">
            包装: ${item.wrapping_flag ?? "-"} | 熨斗: ${item.noshi_flag ?? "-"} | 掛紙: ${item.paper_flag ?? "-"} | 短冊: ${item.short_strip_flag ?? "-"} ｜ 熨斗種: ${item.noshi_type ?? "-"} ｜ できたて: ${item.fresh_flag ?? "-"} ｜ 袋: ${item.bag_flag ?? "-"} ｜ カード: ${item.message_flag ?? "-"}
        </div>
    `;

    return listItem;
}




// アイテムリストの表示
function displayItemList(items) {
    // items が配列でない場合に備えて防御
    if (!Array.isArray(items)) {
        console.error("displayItemList: items が配列ではありません:", items);
        if (items && typeof items === "object") {
            items = Object.values(items);
        } else {
            return;
        }
    }

    const itemListContainer = document.getElementById("itemListContainer");
    const itemList = document.getElementById("itemList");
    itemList.innerHTML = "";

    items.forEach((item) => {
        const listItem = createItemElement(item);
        itemList.appendChild(listItem);
    });

    itemListContainer.style.display = "block";
}



// アイテムの表示更新関数（初期表示とスキャン後の表示を統一）
function updateItemDisplay(item) {
    const oldItem = document.getElementById(`item-${item.item_id}`);
    if (oldItem) {
        const newItem = createItemElement(item);
        // highlight 対象として一貫性を持たせる
        newItem.classList.add("highlight");
        document.querySelectorAll("#itemList li").forEach(el => el.classList.remove("highlight"));
        oldItem.replaceWith(newItem);
    } else {
        console.error(`IDが ${item.item_id} の要素が見つかりませんでした`);
    }
}


// バーコードスキャン機能（配列 items を丸ごと更新する安全版）
function scanBarcode() {
    const barcodeInput = document.getElementById("barcodeInput");
    const pickingIdInput = document.getElementById("pickingIdInput");
    const barcode = barcodeInput.value.trim();

    // 前提チェック
    if (!barcode || !currentPickingId || !currentPickingData || !currentPickingDocRef) {
        playSound('error.mp3', () => {
            alert("バーコードとピッキングIDを入力してください。");
        });
        return;
    }

    // 常に配列として扱う
    const items = Array.isArray(currentPickingData.items)
        ? currentPickingData.items
        : [];

    let allInspected = true;
    let itemUpdated = false;

    const updatedItems = items.map((item) => {
        const quantity = item.quantity ?? 0;
        const scanned  = item.scanned_count ?? 0;

        // 対象アイテム条件：
        //  - バーコード一致
        //  - 検品対象（ins_flg !== 2）
        //  - まだ完了していない
        //  - 予定数量に未達
        if (
            item.barcode === barcode &&
            item.ins_flg !== 2 &&
            !item.item_status &&
            scanned < quantity
        ) {
            const newCount  = scanned + 1;
            const newStatus = newCount >= quantity;

            itemUpdated = true;

            // UI 用に更新後のアイテムを生成
            const updatedItem = {
                ...item,
                scanned_count: newCount,
                item_status: newStatus
            };

            // 一旦ここでハイライト更新
            updateItemDisplay(updatedItem);
            return updatedItem;
        }

        // 検品対象なのに未完了のものが残っていれば allInspected は false
        if (item.ins_flg !== 2 && !item.item_status) {
            allInspected = false;
        }

        return item;
    });

    // 対象アイテムが一つも更新されなかった場合
    if (!itemUpdated) {
        const isBarcodeInItems = items.some((item) => item.barcode === barcode);
        playSound('error.mp3', () => {
            alert(
                isBarcodeInItems
                    ? "このバーコードのアイテムは既に検品済みです。"
                    : "このバーコードは検品対象外です。"
            );
        });
        barcodeInput.value = "";
        return;
    }

    // 全アイテム完了判定を改めて実施
    allInspected = updatedItems.every(
        (item) => item.ins_flg === 2 || item.item_status
    );

    // ローカル状態を更新
    currentPickingData = {
        ...currentPickingData,
        items: updatedItems,
        status: allInspected
    };

    // サウンド＋フォーカス制御
    playSound(allInspected ? 'complete.mp3' : 'success.mp3', () => {
        if (allInspected) {
            pickingIdInput.focus();
        } else {
            barcodeInput.focus();
        }
    });

    // リスト全体を再描画
    displayItemList(updatedItems);

    // Firestore 更新：items を配列ごと上書きする
    const updateData = {
        items: updatedItems,
        status: allInspected
    };

    // 全アイテム完了時は completed_at と BatchInfo を更新
    if (allInspected) {
        updateData.completed_at = firebase.firestore.FieldValue.serverTimestamp();

        if (currentPickingData?.csv_batch_id) {
            db.collection("BatchInfo")
                .doc(currentPickingData.csv_batch_id)
                .set(
                    {
                        csv_batch_id: currentPickingData.csv_batch_id,
                        completed_pickings: firebase.firestore.FieldValue.increment(1)
                    },
                    { merge: true }
                );
        }
    }

    currentPickingDocRef
        .update(updateData)
        .catch((error) => {
            playSound('error.mp3', () => {
                alert("エラーが発生しました。");
            });
            console.error("エラーが発生しました:", error);
        })
        .finally(() => {
            barcodeInput.value = "";
        });
}

//オーディオ再生関数
function playSound(url, callback) {
    const audio = new Audio(url);
    audio.play();
    
    // 音声再生の長さに基づいてコールバックを遅延実行
    audio.onended = callback;
}

// 投入csvごとに進捗を集計して表示
function displayProgressByCsvBatch(batchId) {
    console.log("displayProgressByCsvBatch に渡された batchId:", batchId);

    db.collection("Pickings")
        .where("csv_batch_id", "==", batchId)
        .get()
        .then((querySnapshot) => {
            if (querySnapshot.empty) {
                alert(`指定されたCSVバッチ（${batchId}）のデータが見つかりませんでした。`);
                return;
            }

            let progressList = [];
            querySnapshot.forEach((doc) => {
                const data = doc.data();
                progressList.push({
                    pickingId: doc.id,
                    recipientName: data.recipient_name || "未設定",
                    status: data.status, //  trueなら検品済み、falseなら未検品
                    items: data.items || []
                });
            });

            //  検品済みのピッキングを上部に、未検品を下部にソート
            progressList.sort((a, b) => b.status - a.status);

            updateModalProgressUI(batchId, progressList);
        })
        .catch((error) => {
            console.error("Firestore クエリエラー:", error);
        });
}

function renderBatchList(querySnapshot, { append }) {
    const batchListContainer = document.getElementById("batchListContainer");
    if (!append) {
        batchListContainer.innerHTML = "";
    }

    if (querySnapshot.empty) {
        if (!append) {
            batchListContainer.innerHTML = "<p>バッチがありません</p>";
        }
        return;
    }

    querySnapshot.forEach((doc) => {
        const data = doc.data();
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = `バッチ ${data.csv_batch_id} (${data.completed_pickings || 0}/${data.total_pickings || 0})`;
        button.addEventListener("click", () => openModal(data.csv_batch_id));
        batchListContainer.appendChild(button);
    });
}

function updateShowMoreVisibility(querySnapshot) {
    const showMoreButton = document.getElementById("batchShowMoreButton");
    if (!showMoreButton) {
        return;
    }
    if (querySnapshot.size === BATCH_PAGE_SIZE) {
        showMoreButton.style.display = "inline-block";
    } else {
        showMoreButton.style.display = "none";
    }
}

function loadBatchList({ mode = currentBatchQueryMode, dateRange = currentBatchDateRange, append = false } = {}) {
    const batchListContainer = document.getElementById("batchListContainer");
    if (!batchListContainer) {
        return;
    }

    if (!append) {
        batchListContainer.innerHTML = "<p>読み込み中...</p>";
        lastVisibleBatchDoc = null;
    }

    let query = db.collection("BatchInfo");
    if (mode === "dateRange" && dateRange?.start && dateRange?.end) {
        query = query
            .where("created_at", ">=", dateRange.start)
            .where("created_at", "<", dateRange.end)
            .orderBy("created_at", "desc");
    } else {
        query = query.orderBy("created_at", "desc");
    }

    if (append && lastVisibleBatchDoc) {
        query = query.startAfter(lastVisibleBatchDoc);
    }

    query = query.limit(BATCH_PAGE_SIZE);

    query
        .get()
        .then((querySnapshot) => {
            if (!append) {
                batchListContainer.innerHTML = "";
            }

            renderBatchList(querySnapshot, { append });
            lastVisibleBatchDoc = querySnapshot.docs[querySnapshot.docs.length - 1] || lastVisibleBatchDoc;
            updateShowMoreVisibility(querySnapshot);
        })
        .catch((error) => {
            console.error("バッチ一覧の取得エラー:", error);
            batchListContainer.innerHTML = "<p>バッチの取得中にエラーが発生しました。</p>";
            updateShowMoreVisibility({ size: 0 });
        });
}

function parseDateInputValue(value) {
    if (!value) {
        return null;
    }
    return new Date(`${value}T00:00:00+09:00`);
}

function performDateSearch() {
    const startValue = document.getElementById("batchStartDate").value;
    const endValue = document.getElementById("batchEndDate").value;
    const startDate = parseDateInputValue(startValue);
    const endDate = parseDateInputValue(endValue);

    if (!startDate || !endDate) {
        alert("開始日と終了日を入力してください。");
        return;
    }

    if (startDate > endDate) {
        alert("開始日は終了日より前の日付を選択してください。");
        return;
    }

    const endExclusive = new Date(endDate.getTime() + 24 * 60 * 60 * 1000);

    currentBatchQueryMode = "dateRange";
    currentBatchDateRange = {
        start: startDate,
        end: endExclusive
    };

    loadBatchList({ mode: "dateRange", dateRange: currentBatchDateRange, append: false });
}

function setDateRangeAndSearch(startDate, endDate) {
    document.getElementById("batchStartDate").value = formatDateInput(startDate);
    document.getElementById("batchEndDate").value = formatDateInput(endDate);
    performDateSearch();
}

// 投入バッチごとの進捗データをUIに表示
function updateModalProgressUI(batchId, progressList) {
    const progressContainer = document.getElementById("progressContainerModal");
    progressContainer.innerHTML = `<h2>CSVバッチID: ${batchId} の進捗</h2>`;

    progressList.forEach((progress) => {
        const rowClass = progress.status ? "picking-complete" : "picking-pending";
        progressContainer.innerHTML += `
            <div class="${rowClass}">
                <h3>ピッキングID: ${progress.pickingId}</h3>
                <p>届け先: ${progress.recipientName}</p>
                <p>状態: ${progress.status ? "✔ 検品済み" : "未検品"}</p>
            </div>
        `;
    });

    //  CSVダウンロードボタンを追加
    progressContainer.innerHTML += `<button id="downloadCSVButton" data-batch-id="${batchId}">CSVダウンロード</button>`;
}




// CSVダウンロードボタンのクリックイベント
document.addEventListener("click", function (event) {
    if (event.target && event.target.id === "downloadCSVButton") {
        console.log("ダウンロードボタンがクリックされました");
        const batchId = event.target.getAttribute("data-batch-id"); // data属性から取得
        if (!batchId) {
            alert("CSVバッチIDを取得できませんでした。");
            return;
        }
        downloadCSVByBatchId(batchId);
    }
});


function downloadCSVByBatchId(batchId) {
    if (!batchId || typeof batchId !== "string") {
        console.error("エラー: batchId が無効です", batchId);
        alert("エラー: CSVバッチIDが正しく設定されていません。");
        return;
    }

    console.log("CSVダウンロード: batchId =", batchId);

db.collection("Pickings")
    .where("csv_batch_id", "==", batchId)
    .get()
    .then((querySnapshot) => {
        console.log("Firestore クエリ結果:", querySnapshot.docs.map(doc => doc.data())); // クエリ結果を確認

        if (querySnapshot.empty) {
            alert(`指定されたCSVバッチ（${batchId}）のデータが見つかりませんでした。`);
            console.error("エラー: Firestore に csv_batch_id が一致するデータがありません", batchId);
            return;
        }

        let rows = [["Picking ID", "Recipient Name", "Item ID", "Item Name", "Quantity", "Barcode", "Status"]];

        querySnapshot.forEach((doc) => {
            const data = doc.data();
            console.log("取得したデータ:", data); // 各ドキュメントのデータを確認

            if (!data.items || !Array.isArray(data.items)) {
                console.warn(`警告: Firestore のデータに items が存在しない、または配列ではない:`, data);
                return;
            }

            data.items.forEach((item) => {
                rows.push([
                    doc.id,
                    data.recipient_name || "未設定",
                    item.item_id || "不明",
                    item.item_name || "不明",
                    item.quantity || 0,
                    item.barcode || "不明",
                    item.item_status ? "完了" : "未完了"
                ]);
            });
        });

        if (rows.length === 1) { // ヘッダーしかない場合はデータがない
            alert(`指定されたCSVバッチ（${batchId}）にデータがありません。`);
            console.warn("エラー: 取得したデータに items が存在しない", batchId);
            return;
        }

        const csvContent = rows.map((row) => row.join(",")).join("\n");
        const bom = "\uFEFF";
        const blob = new Blob([bom + csvContent], { type: "text/csv;charset=utf-8;" });

        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = `batch_${batchId}.csv`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    })
    .catch((error) => {
        console.error("CSVダウンロードエラー:", error);
        alert("エラーが発生しました。コンソールを確認してください。");
    });
}


function openModal(batchId) {
    console.log("openModal に渡された batchId:", batchId);

    const modalContainer = document.getElementById("progressModal");
    if (!modalContainer) {
        console.error("エラー: progressModal が見つかりません。");
        return;
    }

    displayProgressByCsvBatch(batchId);
    modalContainer.style.display = "flex";
    modalContainer.classList.add("show");
}

function closeModal() {
    const modal = document.getElementById("progressModal");
    if (modal) {
        modal.classList.remove("show");
        modal.style.display = "none"; // 完全に非表示にする
    }
}

document.addEventListener("DOMContentLoaded", function () {
    console.log("DOMContentLoaded 発火"); // これが表示されるか確認
    const modal = document.getElementById("progressModal");

    if (modal) {
        document.addEventListener("click", function (event) {
            console.log("モーダルクリック検知", event.target); // クリックが検知されるか確認
            if (event.target === modal) {
                closeModal();
            }
        });
    }
});

const style = document.createElement('style');
style.innerHTML = `
.picking-complete { background-color: #d4edda; padding: 10px; margin-bottom: 5px; }
.picking-pending { background-color: #f8d7da; padding: 10px; margin-bottom: 5px; }
`;
document.head.appendChild(style);
