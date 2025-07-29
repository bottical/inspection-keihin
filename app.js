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

// Firebaseを初期化
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
const auth = firebase.auth();

window.addEventListener("load", () => {
    console.log("window.onload 発火: バッチ一覧を読み込む");
});


document.getElementById("loginButton").addEventListener("click", () => {
    const email = document.getElementById("emailInput").value.trim();
    const password = document.getElementById("passwordInput").value.trim();

    auth.signInWithEmailAndPassword(email, password)
        .then((userCredential) => {
            console.log(`ログイン成功: ${userCredential.user.email}`);
        })
        .catch((error) => {
        const errorMessage = error.message;
        alert(`ログイン失敗: ${errorMessage}`);
});
});


// ユーザーのログイン状態を監視
auth.onAuthStateChanged((user) => {
    if (user) {
        document.getElementById("welcomeMessage").textContent = `ようこそ、${user.email} さん`;
        document.getElementById("loginContainer").style.display = "none";
        document.getElementById("userInfo").style.display = "block";
        document.getElementById("logoutButton").style.display = "block";
    } else {
        document.getElementById("loginContainer").style.display = "block";
        document.getElementById("userInfo").style.display = "none";
        document.getElementById("logoutButton").style.display = "none";
    }
});


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

// CSV読み込み機能
function importCSV() {
    const fileInput = document.getElementById("csvFileInput").files[0];
    if (!fileInput) {
        alert("CSVファイルを選択してください。");
        return;
    }

    // 使用するクライアントを選択（例としてclientAを使用）
    const currentClient = clientSettings.clientA;

    const encoding = document.querySelector('input[name="encoding"]:checked').value;
    const reader = new FileReader();

    reader.onload = function (event) {
        const uint8Array = new Uint8Array(event.target.result);
        const text = new TextDecoder(encoding).decode(uint8Array);
        parseCSV(text, currentClient); // currentClientを引数として渡す
    };

    reader.readAsArrayBuffer(fileInput); // ArrayBufferとして読み込む
}

// picking_id を picking_id/item_id（2桁ゼロ埋め）に統合した parseCSV 部分のみ改修

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

        const columns = row.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/).map(col => col.replace(/^"|"$/g, ''));

        const basePickingId = columns[clientConfig.picking_id] || `UNKNOWN_${i}`;
        const itemIdRaw = columns[clientConfig.item_id] || "0";
        const itemIdPadded = itemIdRaw.toString().padStart(2, "0");
        const pickingId = `${basePickingId}/${itemIdPadded}`;

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
                picking_id: pickingId,
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

    // Firestore へ登録
    Promise.all(Object.entries(pickingsData).map(([pickingId, data]) => {
        return db.collection("Pickings").doc(pickingId).set(data)
            .then(() => console.log(`登録成功: ${pickingId}`))
            .catch(error => console.error(`登録失敗: ${pickingId}`, error));
    })).then(() => {
        console.log("インポート完了");
        document.getElementById("statusMessage").innerText = "すべてのデータがFirebaseに追加されました";
    });

    document.getElementById("statusMessage").innerText = "データがFirebaseに追加されました";
}


// CSVバッチIDを作成 (例: 20240203-153045)
function getFormattedTimestamp() {
    const now = new Date();
    return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
}


let currentPickingId = null; // 現在のピッキングIDを格納

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

    // ログイン状態の監視（全ページ共通）
    auth.onAuthStateChanged((user) => {
        const welcomeMessage = document.getElementById("welcomeMessage");
        const loginContainer = document.getElementById("loginContainer");
        const logoutContainer = document.getElementById("logoutContainer");

        if (user) {
            console.log(`ログイン中: ${user.email}`);
            if (welcomeMessage) welcomeMessage.textContent = `ようこそ、${user.email} さん`;
            if (loginContainer) loginContainer.classList.add("hidden");
            if (logoutContainer) logoutContainer.classList.remove("hidden");
        } else {
            console.log("ログアウト状態");
            if (welcomeMessage) welcomeMessage.textContent = "";
            if (loginContainer) loginContainer.classList.remove("hidden");
            if (logoutContainer) logoutContainer.classList.add("hidden");
        }
    });

    // ページ識別用属性（例: <body data-page="inspection">）
    const pageType = document.body.getAttribute("data-page");
    if (!pageType) {
        console.error("ページ識別のための 'data-page' 属性が見つかりません。");
        return;
    }

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

    // 必要に応じて登録ページ固有のイベントリスナーや処理を追加
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

// ピッキングIDでデータを取得して表示
function fetchPickingData() {
    const pickingIdInput = document.getElementById("pickingIdInput");
    let pickingId = pickingIdInput.value.trim();

    if (!pickingId) {
        playSound('error.mp3', () => {
            alert("ピッキングIDを入力してください。");
        });
        return;
    }

    // 🔽 8桁以上なら先頭の8桁を取得し、先頭の0をすべて除去
    if (pickingId.length >= 8) {
    pickingId = pickingId.slice(0, 8).replace(/^0+/, '');
    console.log(`8桁取得後、先頭の0を除去したピッキングID: ${pickingId}`);
    }

    if (currentPickingId && currentPickingId !== pickingId) {
        resetScannedCount(currentPickingId);
    }

    currentPickingId = pickingId;
    // 以下、既存のままでOK

    db.collection("Pickings").doc(currentPickingId).get()
        .then((doc) => {
            if (doc.exists) {
                const data = doc.data();
                if (data.status === true) {
                    playSound('error.mp3', () => {
                        alert("このピッキングIDはすでに検品済みです。");
                    });
                    currentPickingId = null;
                    pickingIdInput.focus();
                } else {
                    playSound('success.mp3'); // 成功音
                    displayItemList(data.items);

                    // 検品中のピッキングIDを表示
                    document.getElementById("currentPickingIdDisplay").textContent = `現在検品中のピッキングID: ${currentPickingId}`;
                    
                    // 届け先氏名とフォーマットされた発送日を表示
                    document.getElementById("recipientNameDisplay").textContent = `届け先氏名: ${data.recipient_name || "未設定"}`;
                    document.getElementById("shipmentDateDisplay").textContent = `発送日: ${formatShipmentDate(data.shipment_date)}`;
                    document.getElementById("barcodeInput").focus();
                }
            } else {
                playSound('error.mp3', () => {
                    alert("該当するピッキングIDが見つかりませんでした。");
                });
                currentPickingId = null;
                pickingIdInput.focus();
                document.getElementById("currentPickingIdDisplay").textContent = ""; // ピッキングID表示をクリア
                document.getElementById("recipientNameDisplay").textContent = "届け先氏名: 不明"; // 届け先氏名をクリア
                document.getElementById("shipmentDateDisplay").textContent = "発送日: 不明"; // 発送日をクリア
            }
        })
        .catch((error) => {
            playSound('error.mp3', () => {
                alert("エラーが発生しました。");
            });
            console.error("エラーが発生しました:", error);
            currentPickingId = null;
            pickingIdInput.focus();
        })
        .finally(() => {
            pickingIdInput.value = "";
        });
}




// 異なるピッキングIDが入力された場合にscanned_countをリセット
function resetScannedCount(pickingId) {
    db.collection("Pickings").doc(pickingId).get()
        .then((doc) => {
            if (doc.exists) {
                const data = doc.data();

                // 検品済みであればリセットしない
                if (data.status === true) {
                    console.log(`ピッキングID ${pickingId} は既に検品済みのためリセットをスキップします。`);
                    return;
                }

                const resetItems = data.items.map((item) => {
                    item.scanned_count = 0;
                    item.item_status = false;
                    return item;
                });

                // Firestoreにリセット状態を更新
                db.collection("Pickings").doc(pickingId).update({
                    items: resetItems,
                    status: false
                }).then(() => {
                    console.log(`ピッキングID ${pickingId} の検品データをリセットしました。`);
                });
            }
        })
        .catch((error) => {
            console.error("scanned_countのリセット中にエラーが発生しました:", error);
        });
}

function createItemElement(item) {
    if (item.scanned_count === undefined) item.scanned_count = 0;

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
        : item.scanned_count > 0
            ? "検品中"
            : "未検品";
    
    const statusClass = statusText;

    listItem.innerHTML = `
        <div style="display: contents;">
            <div style="font-size: 1.2em;">${item.item_name}</div>
            <div>${item.lot_number}</div>
            <div><span>${barcodePrefix}</span><span class="barcode-suffix">${barcodeSuffix}</span></div>
            <div class="status ${statusClass}">${statusText}</div>
            <div style="font-size: 1.5em;">${item.scanned_count}/${item.quantity}</div>
        </div>
        <div style="grid-column: 1 / -1; font-size: 1.1em; color: #666; padding-top: 5px; padding-left: 10px;">
            包装: ${item.wrapping_flag} | 熨斗: ${item.noshi_flag} | 掛紙: ${item.paper_flag} | 短冊: ${item.short_strip_flag} ｜ 熨斗種: ${item.noshi_type} ｜ できたて: ${item.fresh_flag} ｜ 袋: ${item.bag_flag} ｜ カード: ${item.message_flag}
        </div>
    `;

    return listItem;
}




// アイテムリストの表示
function displayItemList(items) {
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


// バーコードスキャン機能
function scanBarcode() {
    const barcodeInput = document.getElementById("barcodeInput");
    const pickingIdInput = document.getElementById("pickingIdInput");
    const barcode = barcodeInput.value.trim();

    if (!barcode || !currentPickingId) {
        playSound('error.mp3', () => { alert("バーコードとピッキングIDを入力してください。"); });
        return;
    }

    db.collection("Pickings").doc(currentPickingId).get()
        .then((doc) => {
            if (doc.exists) {
                const data = doc.data();
                let allInspected = true;
                let itemUpdated = false;

                const updatedItems = data.items.map((item) => {
                    if (item.barcode === barcode && item.ins_flg !== 2 && !item.item_status && item.scanned_count < item.quantity) {
                        item.scanned_count += 1;
                        if (item.scanned_count >= item.quantity) {
                            item.item_status = true;
                        }
                        itemUpdated = true;
                        updateItemDisplay(item);
                    }

                    if (item.ins_flg !== 2 && !item.item_status) {
                        allInspected = false;
                    }

                    return item;
                });

                if (!itemUpdated) {
                    const isBarcodeInItems = data.items.some((item) => item.barcode === barcode);
                    playSound(isBarcodeInItems ? 'error.mp3' : 'error.mp3', () => {
                        alert(isBarcodeInItems ? "このバーコードのアイテムは既に検品済みです。" : "このバーコードは検品対象外です。");
                    });
                } else {
                    playSound(allInspected ? 'complete.mp3' : 'success.mp3', () => {
                        // 🔹 検品完了時にピッキングIDの入力フィールドへフォーカス
                        if (allInspected) {
                            pickingIdInput.focus();
                        } else {
                            barcodeInput.focus();
                        }
                    });
                    displayItemList(updatedItems);
                }

                const updateData = { items: updatedItems, status: allInspected };
                if (allInspected) {
                    updateData.completed_at = firebase.firestore.FieldValue.serverTimestamp();
                }

                return db.collection("Pickings").doc(currentPickingId).update(updateData);
            }
        })
        .catch((error) => {
            playSound('error.mp3', () => { alert("エラーが発生しました。"); });
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

// 進捗確認ボタンを押したときにのみ集計を実行
document.getElementById("progressCheckButton").addEventListener("click", () => {
    loadBatchListFromPickings();
});

function loadBatchListFromPickings() {
    const batchListContainer = document.getElementById("batchListContainer");
    batchListContainer.innerHTML = "<p>読み込み中...</p>";

    db.collection("Pickings")
        .orderBy("created_at", "desc") //作成日時順に並べる
        .get()
        .then((querySnapshot) => {
            if (querySnapshot.empty) {
                batchListContainer.innerHTML = "<p>バッチがありません</p>";
                return;
            }

            let batchMap = new Map();

            //Firestore から取得したデータを処理
            querySnapshot.forEach(doc => {
                const data = doc.data();
                const batchId = data.csv_batch_id;

                if (!batchId) return; //`csv_batch_id` がないデータは無視

                if (!batchMap.has(batchId)) {
                    batchMap.set(batchId, {
                        csv_batch_id: batchId,
                        total_pickings: 0,      //バッチ内のピッキング数
                        completed_pickings: 0,  //検品済みのピッキング数
                        created_at: data.created_at?.toDate() || new Date(0) //Firestore Timestamp を Date に変換
                    });
                }

                let batchData = batchMap.get(batchId);
                batchData.total_pickings += 1;
                if (data.status === true) {
                    batchData.completed_pickings += 1; //検品済みならカウント
                }
            });

            //ユニークな `csv_batch_id` を作成日時順（降順）で並べ、最新5件のみ取得
            const latestBatches = Array.from(batchMap.values())
                .sort((a, b) => b.created_at - a.created_at) //`created_at` の降順でソート
                .slice(0, 5); //最新5バッチを取得

            let batchHtml = "";
            latestBatches.forEach(batch => {
                batchHtml += `<button onclick="openModal('${batch.csv_batch_id}')">
                                バッチ ${batch.csv_batch_id} (${batch.completed_pickings}/${batch.total_pickings})
                              </button>`;
            });

            batchListContainer.innerHTML = batchHtml;
        })
        .catch((error) => {
            console.error("バッチ一覧の取得エラー:", error);
        });
}





// ページロード時のバッチ一覧取得を削除
// document.addEventListener("DOMContentLoaded", () => {
//     console.log("DOMContentLoaded 発火: バッチ一覧をロード");
//     loadBatchListFromPickings();  // ← この行を削除
// });

// 進捗確認ボタンを押したときのみバッチ一覧を取得
document.getElementById("progressCheckButton").addEventListener("click", () => {
    console.log("進捗確認ボタンが押されました");
    loadBatchListFromPickings();
});



// 最新のバッチ一覧を取得して表示
function loadBatchList() {
    const batchListContainer = document.getElementById("batchListContainer");
    batchListContainer.innerHTML = "読み込み中...";

    db.collection("BatchInfo")
        .orderBy("created_at", "desc")
        .limit(10) // 最新10件を取得
        .get()
        .then((querySnapshot) => {
            batchListContainer.innerHTML = ""; // 初期化

            if (querySnapshot.empty) {
                batchListContainer.innerHTML = "<p>バッチがありません</p>";
                return;
            }

            querySnapshot.forEach((doc) => {
                const data = doc.data();
                const batchId = data.csv_batch_id;

                const button = document.createElement("button");
                button.textContent = `バッチ ${batchId} (${data.completed_items}/${data.total_items})`;
                button.onclick = () => openModal(batchId);

                batchListContainer.appendChild(button);
            });
        })
        .catch((error) => {
            console.error("バッチ一覧の取得エラー:", error);
        });
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
