import React, { useState, useRef, useEffect } from 'react';
import { Upload, Camera, FileSpreadsheet, CheckCircle2, AlertCircle, X, Download, ChevronRight, Search, LogIn, LogOut, Save, Key } from 'lucide-react';
import * as XLSX from 'xlsx';
import { GoogleGenAI, Type } from '@google/genai';
import { cn, findBestMatch, normalizeString, processMattressDimensions, processThickness } from './lib/utils';
import { auth, db } from './firebase';
import { signInWithPopup, GoogleAuthProvider, signOut, onAuthStateChanged, User } from 'firebase/auth';
import { collection, query, where, onSnapshot, doc, setDoc, serverTimestamp, getDocFromServer, writeBatch } from 'firebase/firestore';

// --- Error Handling ---
enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | undefined;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email || undefined,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId || undefined,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// --- Types ---
interface ExtractedItem {
  id: string;
  rawName: string;
  originalName: string;
  dimensions?: string;
  thickness?: string;
  quantity: number;
  price: number;
  total: number;
  matchedProduct: any | null;
}

interface DbProduct {
  [key: string]: any;
}

// --- Main Component ---
export default function App() {
  // State
  const [step, setStep] = useState<number>(1);
  const [dbFile, setDbFile] = useState<File | null>(null);
  const [templateFile, setTemplateFile] = useState<File | null>(null);
  const [dbData, setDbData] = useState<DbProduct[]>([]);
  const [templateHeaders, setTemplateHeaders] = useState<string[]>([]);
  const [images, setImages] = useState<File[]>([]);
  const [extractedItems, setExtractedItems] = useState<ExtractedItem[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isUploadingDb, setIsUploadingDb] = useState(false);
  const [isSavingMatches, setIsSavingMatches] = useState(false);
  const [hasAutoTransitioned, setHasAutoTransitioned] = useState(false);
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [hasCustomKey, setHasCustomKey] = useState(false);
  const [showApiKeyModal, setShowApiKeyModal] = useState(false);
  const [localApiKey, setLocalApiKey] = useState(localStorage.getItem('gemini_api_key') || '');
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [savedMappings, setSavedMappings] = useState<Record<string, string>>({});
  const [user, setUser] = useState<User | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);

  // Refs
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  // --- Effects ---
  useEffect(() => {
    const checkKey = async () => {
      if ((window as any).aistudio?.hasSelectedApiKey) {
        try {
          const hasKey = await (window as any).aistudio.hasSelectedApiKey();
          setHasCustomKey(hasKey);
        } catch (e) {
          console.error("Lỗi khi kiểm tra API key:", e);
        }
      } else {
        setHasCustomKey(!!localStorage.getItem('gemini_api_key'));
      }
    };
    checkKey();
    window.addEventListener('focus', checkKey);
    return () => window.removeEventListener('focus', checkKey);
  }, [localApiKey]);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setIsAuthReady(true);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    async function testConnection() {
      try {
        await getDocFromServer(doc(db, 'test', 'connection'));
      } catch (error) {
        if(error instanceof Error && error.message.includes('the client is offline')) {
          console.error("Please check your Firebase configuration. ");
        }
      }
    }
    testConnection();
  }, []);

  useEffect(() => {
    if (!isAuthReady) return;

    if (user) {
      // Load from Firestore if logged in
      const q = query(collection(db, 'mappings'), where('userId', '==', user.uid));
      const unsubscribe = onSnapshot(q, (snapshot) => {
        const mappings: Record<string, string> = {};
        snapshot.forEach((doc) => {
          const data = doc.data();
          mappings[data.rawName] = data.productCode;
        });
        setSavedMappings(mappings);
      }, (error) => {
        handleFirestoreError(error, OperationType.LIST, 'mappings');
      });
      // Load products
      const qProducts = query(collection(db, 'products'), where('userId', '==', user.uid));
      const unsubProducts = onSnapshot(qProducts, (snapshot) => {
        const products: DbProduct[] = [];
        snapshot.forEach((doc) => {
          try {
            const data = doc.data();
            if (data.data) {
              products.push(JSON.parse(data.data));
            }
          } catch (e) {
            console.error("Failed to parse product data", e);
          }
        });
        if (products.length > 0) {
          setDbData(products);
        }
      }, (error) => {
        handleFirestoreError(error, OperationType.LIST, 'products');
      });

      // Load template
      const unsubTemplate = onSnapshot(doc(db, 'templates', user.uid), (docSnap) => {
        if (docSnap.exists()) {
          const data = docSnap.data();
          if (data.headers && Array.isArray(data.headers)) {
            setTemplateHeaders(data.headers);
          }
        }
      }, (error) => {
        handleFirestoreError(error, OperationType.GET, `templates/${user.uid}`);
      });

      return () => {
        unsubscribe();
        unsubProducts();
        unsubTemplate();
      };
    } else {
      // Load from localStorage if not logged in
      const stored = localStorage.getItem('manquy_mappings');
      if (stored) {
        try {
          setSavedMappings(JSON.parse(stored));
        } catch (e) {
          console.error("Failed to parse mappings", e);
        }
      } else {
        setSavedMappings({});
      }
      
      const storedTemplate = localStorage.getItem('manquy_template');
      if (storedTemplate) {
        try {
          setTemplateHeaders(JSON.parse(storedTemplate));
        } catch (e) {
          console.error("Failed to parse template", e);
        }
      }
    }
  }, [isAuthReady, user]);

  useEffect(() => {
    if (step === 1 && !hasAutoTransitioned && dbData.length > 0 && templateHeaders.length > 0 && user) {
      setStep(2);
      setHasAutoTransitioned(true);
    }
  }, [step, hasAutoTransitioned, dbData, templateHeaders, user]);

  // --- Handlers ---

  const handleLogin = async () => {
    try {
      const provider = new GoogleAuthProvider();
      await signInWithPopup(auth, provider);
    } catch (err) {
      console.error("Login failed", err);
    }
  };

  const handleLogout = async () => {
    try {
      await signOut(auth);
      setDbData([]);
      setTemplateHeaders([]);
      setStep(1);
      setHasAutoTransitioned(false);
    } catch (err) {
      console.error("Logout failed", err);
    }
  };

  const handleDbUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setDbFile(file);
    try {
      const data = await file.arrayBuffer();
      const workbook = XLSX.read(data, { type: 'array' });
      const firstSheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[firstSheetName];
      const json = XLSX.utils.sheet_to_json(worksheet);
      
      if (user) {
        setIsUploadingDb(true);
        const dbKeys = Object.keys(json[0] || {});
        const nameKey = dbKeys.find(k => k.toLowerCase().includes('tên') || k.toLowerCase().includes('name')) || dbKeys[1];
        const codeKey = dbKeys.find(k => k.toLowerCase().includes('mã') || k.toLowerCase().includes('code')) || dbKeys[0];

        const chunks = [];
        for (let i = 0; i < json.length; i += 400) {
          chunks.push(json.slice(i, i + 400));
        }
        
        for (const chunk of chunks) {
          const batch = writeBatch(db);
          chunk.forEach((item: any) => {
            const code = item[codeKey];
            const name = item[nameKey];
            if (!code || !name) return;
            
            const codeStr = String(code).substring(0, 199);
            const nameStr = String(name).substring(0, 499);
            
            const productId = `${user.uid}_${codeStr.replace(/[^a-zA-Z0-9]/g, '_')}`.substring(0, 150);
            const docRef = doc(db, 'products', productId);
            batch.set(docRef, {
              userId: user.uid,
              code: codeStr,
              name: nameStr,
              data: JSON.stringify(item).substring(0, 99999),
              updatedAt: serverTimestamp()
            }, { merge: true });
          });
          await batch.commit();
        }
        setIsUploadingDb(false);
      } else {
        setDbData(json as DbProduct[]);
      }
      setError(null);
    } catch (err) {
      console.error(err);
      setError("Lỗi khi đọc file Database KiotViet. Vui lòng kiểm tra lại định dạng.");
      setIsUploadingDb(false);
    }
  };

  const handleTemplateUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setTemplateFile(file);
    try {
      const data = await file.arrayBuffer();
      const workbook = XLSX.read(data, { type: 'array' });
      const firstSheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[firstSheetName];
      const json = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
      if (json.length > 0) {
        const headers = (json[0] as string[]).slice(0, 200);
        setTemplateHeaders(headers);
        
        if (user) {
          setDoc(doc(db, 'templates', user.uid), {
            userId: user.uid,
            headers: headers,
            updatedAt: serverTimestamp()
          }).then(() => {
            setSuccessMessage("Đã lưu Form mẫu");
            setTimeout(() => setSuccessMessage(null), 3000);
          }).catch(error => {
            handleFirestoreError(error, OperationType.WRITE, `templates/${user.uid}`);
          });
        } else {
          localStorage.setItem('manquy_template', JSON.stringify(headers));
          setSuccessMessage("Đã lưu Form mẫu");
          setTimeout(() => setSuccessMessage(null), 3000);
        }
      }
      setError(null);
    } catch (err) {
      console.error(err);
      setError("Lỗi khi đọc file Form mẫu KiotViet. Vui lòng kiểm tra lại định dạng.");
    }
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      setImages((prev) => [...prev, ...Array.from(e.target.files!)]);
    }
  };

  const removeImage = (index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  };

  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => {
        const result = reader.result as string;
        // Extract base64 part
        const base64 = result.split(',')[1];
        resolve(base64);
      };
      reader.onerror = (error) => reject(error);
    });
  };

  const processImages = async () => {
    if (images.length === 0) {
      setError("Vui lòng tải lên ít nhất 1 ảnh hóa đơn.");
      return;
    }
    if (dbData.length === 0) {
      setError("Vui lòng tải lên file Database KiotViet trước.");
      return;
    }

    setIsProcessing(true);
    setError(null);

    try {
      const apiKey = localStorage.getItem('gemini_api_key') || process.env.GEMINI_API_KEY;
      const ai = new GoogleGenAI({ apiKey });
      
      const imageParts = await Promise.all(
        images.map(async (file) => {
          const base64 = await fileToBase64(file);
          return {
            inlineData: {
              data: base64,
              mimeType: file.type,
            },
          };
        })
      );

      const prompt = `Trích xuất danh sách các mặt hàng từ (các) hóa đơn này. 
      Trả về một mảng JSON các đối tượng với các thuộc tính:
      - name: Tên sản phẩm/hàng hóa (chuỗi)
      - dimensions: Kích thước (chuỗi, ví dụ: "1m2 x 2m4", "phi 10", để trống nếu không có)
      - thickness: Độ dày (chuỗi, ví dụ: "1,2mm", "5 dem", "2,5". QUAN TRỌNG: Nếu trên hóa đơn ghi độ dày theo mm như 90, 45, 50, 100, hãy quy đổi sang đơn vị phân (F) theo quy tắc: 90mm -> 9F, 45mm -> 5F (làm tròn 4.5 thành 5), 50mm -> 5F, 100mm -> 10F, 150mm -> 15F. Trả về kết quả đã quy đổi (ví dụ: "9F", "5F"). Sử dụng dấu phẩy "," cho số thập phân nếu có)
      - quantity: Số lượng (số)
      - price: Đơn giá (số). QUAN TRỌNG: Nếu trên hóa đơn có giá gốc và giá sau chiết khấu (CK), hãy lấy giá sau chiết khấu làm đơn giá.
      - total: Thành tiền (số). QUAN TRỌNG: Nếu có chiết khấu theo dòng, hãy lấy giá trị thành tiền cuối cùng sau khi đã trừ chiết khấu.
      Không bao gồm bất kỳ văn bản nào khác ngoài JSON.`;

      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: {
          parts: [
            { text: prompt },
            ...imageParts
          ]
        },
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                name: { type: Type.STRING, description: "Tên sản phẩm/hàng hóa" },
                dimensions: { type: Type.STRING, description: "Kích thước" },
                thickness: { type: Type.STRING, description: "Độ dày" },
                quantity: { type: Type.NUMBER, description: "Số lượng" },
                price: { type: Type.NUMBER, description: "Đơn giá (ưu tiên giá sau chiết khấu/CK)" },
                total: { type: Type.NUMBER, description: "Thành tiền (giá trị cuối cùng sau chiết khấu)" }
              },
              required: ["name", "quantity"]
            }
          }
        }
      });

      const jsonText = response.text;
      if (!jsonText) throw new Error("Không nhận được phản hồi từ AI.");
      
      const parsedItems = JSON.parse(jsonText);
      
      // Find the column name for Product Name in DB
      const dbKeys = Object.keys(dbData[0] || {});
      const nameKey = dbKeys.find(k => k.toLowerCase().includes('tên') || k.toLowerCase().includes('name')) || dbKeys[1];
      const codeKey = dbKeys.find(k => k.toLowerCase().includes('mã') || k.toLowerCase().includes('code')) || dbKeys[0];

      // Group parsed items
      const groupedItemsMap = new Map<string, any>();
      
      parsedItems.forEach((item: any) => {
        const processedName = processMattressDimensions(item.name || "");
        const processedDim = processMattressDimensions(item.dimensions || "");
        const processedThick = processThickness(item.thickness || "");
        
        const fullNameParts = [processedName, processedDim, processedThick].filter(Boolean);
        const fullName = fullNameParts.join(' - ');
        const normalizedRaw = normalizeString(fullName);
        
        if (groupedItemsMap.has(normalizedRaw)) {
          const existing = groupedItemsMap.get(normalizedRaw);
          existing.quantity = (existing.quantity || 1) + (item.quantity || 1);
          existing.total = (existing.total || 0) + (item.total || ((item.quantity || 1) * (item.price || 0)));
        } else {
          groupedItemsMap.set(normalizedRaw, {
            ...item,
            _processedName: processedName,
            _processedDim: processedDim,
            _processedThick: processedThick,
            _fullName: fullName,
            _normalizedRaw: normalizedRaw,
            quantity: item.quantity || 1,
            price: item.price || 0,
            total: item.total || ((item.quantity || 1) * (item.price || 0))
          });
        }
      });

      const groupedItems = Array.from(groupedItemsMap.values());

      const matched: ExtractedItem[] = groupedItems.map((item: any, index: number) => {
        let bestMatch = null;
        
        // 1. Check saved mappings first
        if (savedMappings[item._normalizedRaw]) {
          bestMatch = dbData.find(d => d[codeKey] === savedMappings[item._normalizedRaw]);
        }
        
        // 2. Fallback to fuzzy match
        if (!bestMatch) {
          bestMatch = findBestMatch({
            name: item._processedName,
            dimensions: item._processedDim,
            thickness: item._processedThick,
            rawName: item._fullName
          }, dbData, nameKey);
        }

        return {
          id: `item-${index}-${Date.now()}`,
          rawName: item._fullName,
          originalName: item.name,
          dimensions: item._processedDim || item.dimensions,
          thickness: item._processedThick || item.thickness,
          quantity: item.quantity,
          price: item.price,
          total: item.total,
          matchedProduct: bestMatch
        };
      });

      setExtractedItems(matched);
      setStep(3);
    } catch (err: any) {
      console.error(err);
      let errorMessage = "Đã xảy ra lỗi khi xử lý ảnh. Vui lòng thử lại.";
      
      try {
        // Try to parse the error message if it's a JSON string
        const errorObj = JSON.parse(err.message);
        if (errorObj?.error?.code === 429 || errorObj?.error?.status === "RESOURCE_EXHAUSTED") {
          errorMessage = "Đã hết hạn mức sử dụng AI. Vui lòng thử lại sau hoặc cấu hình API Key cá nhân để tiếp tục.";
        } else if (errorObj?.error?.message) {
          errorMessage = errorObj.error.message;
        }
      } catch (e) {
        // If it's not JSON, use the original message or fallback
        if (err.message && (err.message.includes("429") || err.message.includes("RESOURCE_EXHAUSTED") || err.message.includes("quota") || err.message.includes("spending cap"))) {
           errorMessage = "Đã hết hạn mức sử dụng AI. Vui lòng thử lại sau hoặc cấu hình API Key cá nhân để tiếp tục.";
        } else {
           errorMessage = err.message || errorMessage;
        }
      }
      
      setError(errorMessage);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleManualMatch = (itemId: string, dbItem: any) => {
    setExtractedItems(prev => prev.map(item => {
      if (item.id === itemId) {
        const normalizedRaw = normalizeString(item.rawName);
        const dbKeys = Object.keys(dbData[0] || {});
        const codeKey = dbKeys.find(k => k.toLowerCase().includes('mã') || k.toLowerCase().includes('code')) || dbKeys[0];
        
        // Save mapping to localStorage as fallback
        const newMappings = {
          ...savedMappings,
          [normalizedRaw]: dbItem[codeKey]
        };
        setSavedMappings(newMappings);
        localStorage.setItem('manquy_mappings', JSON.stringify(newMappings));
        
        // Save to Firestore if logged in
        if (user) {
          const productCode = String(dbItem[codeKey] || '').substring(0, 199);
          const truncatedRaw = normalizedRaw.substring(0, 499);
          if (truncatedRaw && productCode) {
            const mappingId = `${user.uid}_${truncatedRaw.replace(/[^a-zA-Z0-9]/g, '_')}`.substring(0, 150);
            const mappingData: any = {
              userId: user.uid,
              rawName: truncatedRaw,
              productCode: productCode,
              updatedAt: serverTimestamp()
            };
            if (item.rawName) mappingData.standardizedName = item.rawName.substring(0, 499);
            if (item.dimensions) mappingData.dimensions = item.dimensions.substring(0, 99);
            if (item.thickness) mappingData.thickness = item.thickness.substring(0, 99);

            setDoc(doc(db, 'mappings', mappingId), mappingData).catch(error => {
              handleFirestoreError(error, OperationType.WRITE, `mappings/${mappingId}`);
            });
          }
        }
        
        return { ...item, matchedProduct: dbItem };
      }
      return item;
    }));
  };

  const handleClearMatch = (itemId: string) => {
    setExtractedItems(prev => prev.map(item => {
      if (item.id === itemId) {
        return { ...item, matchedProduct: null };
      }
      return item;
    }));
  };

  const handlePriceChange = (itemId: string, newPrice: number) => {
    setExtractedItems(prev => prev.map(item => {
      if (item.id === itemId) {
        return { ...item, price: newPrice, total: newPrice * (item.quantity || 1) };
      }
      return item;
    }));
  };

  const handleQuantityChange = (itemId: string, newQuantity: number) => {
    setExtractedItems(prev => prev.map(item => {
      if (item.id === itemId) {
        return { ...item, quantity: newQuantity, total: (item.price || 0) * newQuantity };
      }
      return item;
    }));
  };

  const saveAllMatches = async (isManual: boolean = false) => {
    if (extractedItems.length === 0) return;
    
    if (!user) {
      if (isManual) {
        setError("Vui lòng đăng nhập để lưu kết quả đối chiếu.");
      }
      return;
    }
    
    setIsSavingMatches(true);
    try {
      const batch = writeBatch(db);
      let count = 0;
      
      const dbKeys = Object.keys(dbData[0] || {});
      const codeKey = dbKeys.find(k => k.toLowerCase().includes('mã') || k.toLowerCase().includes('code')) || dbKeys[0];

      const chunks = [];
      let currentChunk = [];
      
      extractedItems.forEach(item => {
        if (item.matchedProduct) {
          const normalizedRaw = normalizeString(item.rawName).substring(0, 499);
          const productCode = String(item.matchedProduct[codeKey] || '').substring(0, 199);
          
          if (!normalizedRaw || !productCode) return;
          
          const mappingId = `${user.uid}_${normalizedRaw.replace(/[^a-zA-Z0-9]/g, '_')}`.substring(0, 150);
          const mappingRef = doc(db, 'mappings', mappingId);
          
          const mappingData: any = {
            userId: user.uid,
            rawName: normalizedRaw,
            productCode: productCode,
            updatedAt: serverTimestamp()
          };
          if (item.rawName) mappingData.standardizedName = item.rawName.substring(0, 499);
          if (item.dimensions) mappingData.dimensions = item.dimensions.substring(0, 99);
          if (item.thickness) mappingData.thickness = item.thickness.substring(0, 99);

          currentChunk.push({
            ref: mappingRef,
            data: mappingData
          });
          
          if (currentChunk.length === 400) {
            chunks.push(currentChunk);
            currentChunk = [];
          }
        }
      });
      
      if (currentChunk.length > 0) {
        chunks.push(currentChunk);
      }
      
      for (const chunk of chunks) {
        const batch = writeBatch(db);
        chunk.forEach(op => batch.set(op.ref, op.data));
        await batch.commit();
      }
      
      if (chunks.length > 0 && isManual) {
        setError(null);
      }
    } catch (error) {
      console.error("Error saving matches:", error);
      if (isManual) {
        setError("Có lỗi xảy ra khi lưu kết quả đối chiếu.");
      }
    } finally {
      setIsSavingMatches(false);
    }
  };

  const exportExcel = async () => {
    if (templateHeaders.length === 0) {
      setError("Vui lòng tải lên file Form mẫu KiotViet để biết định dạng xuất.");
      return;
    }

    try {
      // Save matches before exporting
      await saveAllMatches();

      // Find relevant keys in DB
      const dbKeys = Object.keys(dbData[0] || {});
      const nameKey = dbKeys.find(k => k.toLowerCase().includes('tên') || k.toLowerCase().includes('name')) || dbKeys[1];
      const codeKey = dbKeys.find(k => k.toLowerCase().includes('mã') || k.toLowerCase().includes('code')) || dbKeys[0];

      // Find relevant indices in template headers
      const getHeaderIndex = (keywords: string[]) => {
        return templateHeaders.findIndex(h => keywords.some(kw => h.toLowerCase().includes(kw)));
      };

      const codeIdx = getHeaderIndex(['mã hàng', 'mã sản phẩm', 'code']);
      const nameIdx = getHeaderIndex(['tên hàng', 'tên sản phẩm', 'name']);
      const qtyIdx = getHeaderIndex(['số lượng', 'quantity', 'sl']);
      const priceIdx = getHeaderIndex(['đơn giá', 'giá', 'price']);
      const totalIdx = getHeaderIndex(['thành tiền', 'tổng', 'total']);

      const rows = extractedItems.map(item => {
        const row = new Array(templateHeaders.length).fill('');
        
        let finalName = item.matchedProduct ? item.matchedProduct[nameKey] : item.rawName;
        if (!item.matchedProduct && (item.dimensions || item.thickness)) {
          const parts = [item.originalName, item.dimensions, item.thickness].filter(Boolean);
          finalName = parts.join(' - ');
        }

        if (codeIdx !== -1 && item.matchedProduct) row[codeIdx] = item.matchedProduct[codeKey];
        if (nameIdx !== -1) row[nameIdx] = finalName;
        if (qtyIdx !== -1) row[qtyIdx] = item.quantity;
        if (priceIdx !== -1) row[priceIdx] = item.price;
        if (totalIdx !== -1) row[totalIdx] = item.total;
        
        return row;
      });

      const worksheet = XLSX.utils.aoa_to_sheet([templateHeaders, ...rows]);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, "NhapHang");
      
      XLSX.writeFile(workbook, `PhieuNhapHang_${new Date().getTime()}.xlsx`);
    } catch (error) {
      console.error("Error exporting excel:", error);
      setError("Có lỗi xảy ra khi xuất file Excel. Vui lòng thử lại.");
    }
  };

  // --- UI Components ---

  const renderStep1 = () => (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        {/* DB Upload */}
        <div className="glass rounded-3xl p-10 text-center hover:shadow-xl transition-all relative overflow-hidden group">
          {isUploadingDb && (
            <div className="absolute inset-0 bg-white/60 backdrop-blur-md flex flex-col items-center justify-center z-10">
              <div className="w-10 h-10 border-4 border-luxury-gold border-t-transparent rounded-full animate-spin mb-3"></div>
              <p className="text-xs font-bold uppercase tracking-widest text-luxury-gold">Đang đồng bộ...</p>
            </div>
          )}
          <div className="mx-auto w-16 h-16 bg-beige text-slate-grey rounded-2xl flex items-center justify-center mb-6 shadow-inner group-hover:scale-110 transition-transform">
            <FileSpreadsheet className="w-8 h-8" />
          </div>
          <h3 className="text-xl font-bold text-slate-grey mb-3 uppercase tracking-tight">Dữ liệu KiotViet</h3>
          <p className="text-sm text-slate-grey/60 mb-8 leading-relaxed">
            {dbData.length > 0 
              ? `Hệ thống đã sẵn sàng với ${dbData.length} mặt hàng cao cấp.` 
              : "Tải lên danh mục sản phẩm từ KiotViet để bắt đầu đối chiếu thông minh."}
          </p>
          <input
            type="file"
            accept=".xlsx, .xls"
            className="hidden"
            id="db-upload"
            onChange={handleDbUpload}
            disabled={isUploadingDb}
          />
          <label
            htmlFor="db-upload"
            className={cn(
              "inline-flex items-center justify-center px-8 py-3 bg-luxury-gold text-white rounded-full text-xs font-bold uppercase tracking-widest hover:bg-luxury-gold/90 transition-all shadow-lg",
              isUploadingDb ? "opacity-50 cursor-not-allowed" : "cursor-pointer"
            )}
          >
            {dbData.length > 0 ? "Cập nhật dữ liệu" : "Chọn file Excel"}
          </label>
          {dbFile && !isUploadingDb && (
            <div className="mt-6 flex items-center justify-center text-xs text-luxury-gold font-bold uppercase tracking-widest">
              <CheckCircle2 className="w-4 h-4 mr-2" />
              {dbFile.name}
            </div>
          )}
        </div>

        {/* Template Upload */}
        <div className="glass rounded-3xl p-10 text-center hover:shadow-xl transition-all group">
          <div className="mx-auto w-16 h-16 bg-beige text-slate-grey rounded-2xl flex items-center justify-center mb-6 shadow-inner group-hover:scale-110 transition-transform">
            <FileSpreadsheet className="w-8 h-8" />
          </div>
          <h3 className="text-xl font-bold text-slate-grey mb-3 uppercase tracking-tight">Mẫu Nhập Hàng</h3>
          <p className="text-sm text-slate-grey/60 mb-8 leading-relaxed">
            {templateHeaders.length > 0
              ? `Form mẫu hiện tại có ${templateHeaders.length} trường thông tin.`
              : "Thiết lập định dạng xuất file để tương thích hoàn hảo với KiotViet."}
          </p>
          <input
            type="file"
            accept=".xlsx, .xls"
            className="hidden"
            id="template-upload"
            onChange={handleTemplateUpload}
          />
          <label
            htmlFor="template-upload"
            className="inline-flex items-center justify-center px-8 py-3 bg-luxury-gold text-beige rounded-full text-xs font-bold uppercase tracking-widest hover:bg-luxury-gold/90 transition-all shadow-lg cursor-pointer"
          >
            {templateHeaders.length > 0 ? "Thay đổi Form mẫu" : "Chọn file Excel"}
          </label>
          {templateFile && (
            <div className="mt-6 flex items-center justify-center text-xs text-luxury-gold font-bold uppercase tracking-widest">
              <CheckCircle2 className="w-4 h-4 mr-2" />
              {templateFile.name}
            </div>
          )}
        </div>
      </div>

      <div className="flex justify-center pt-6">
        <button
          onClick={() => setStep(2)}
          disabled={dbData.length === 0 || templateHeaders.length === 0 || isUploadingDb}
          className="inline-flex items-center px-10 py-4 bg-luxury-gold text-white rounded-full font-bold uppercase tracking-[0.2em] text-xs hover:bg-luxury-gold/90 disabled:opacity-30 disabled:cursor-not-allowed transition-all shadow-xl hover:-translate-y-1"
        >
          Tiếp tục hành trình
          <ChevronRight className="w-4 h-4 ml-3" />
        </button>
      </div>
    </div>
  );

  const renderStep2 = () => (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
        <h3 className="text-lg font-semibold text-slate-900 mb-4">Tải lên ảnh hóa đơn</h3>
        
        <div className="flex flex-wrap gap-4 mb-6">
          <input
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            ref={fileInputRef}
            onChange={handleImageUpload}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center px-6 py-3 bg-white border border-luxury-gold/20 rounded-xl text-sm font-bold uppercase tracking-widest text-luxury-gold hover:bg-beige transition-all shadow-sm"
          >
            <Upload className="w-4 h-4 mr-3" />
            Tải ảnh lên
          </button>

          <input
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            ref={cameraInputRef}
            onChange={handleImageUpload}
          />
          <button
            onClick={() => cameraInputRef.current?.click()}
            className="inline-flex items-center px-6 py-3 bg-luxury-gold text-beige rounded-xl text-sm font-bold uppercase tracking-widest hover:bg-luxury-gold/90 transition-all shadow-lg"
          >
            <Camera className="w-4 h-4 mr-3" />
            Chụp ảnh
          </button>
        </div>

        {images.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4 mb-6">
            {images.map((file, idx) => {
              const imageUrl = URL.createObjectURL(file);
              return (
                <div key={idx} className="relative group aspect-square rounded-lg overflow-hidden border border-slate-200 bg-slate-50">
                  <img
                    src={imageUrl}
                    alt={`Invoice ${idx + 1}`}
                    className="w-full h-full object-cover cursor-pointer hover:scale-105 transition-transform"
                    onClick={() => setSelectedImage(imageUrl)}
                  />
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      removeImage(idx);
                    }}
                    className="absolute top-2 right-2 p-1 bg-black/50 text-white rounded-full opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-500"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        <div className="flex justify-between items-center pt-4 border-t border-slate-100">
          <button
            onClick={() => setStep(1)}
            className="inline-flex items-center justify-center px-8 py-4 bg-white border border-slate-grey/20 text-slate-grey rounded-full text-xs font-bold uppercase tracking-widest hover:bg-beige transition-all shadow-sm"
          >
            Quay lại
          </button>
          <button
            onClick={processImages}
            disabled={images.length === 0 || isProcessing}
            className="inline-flex items-center px-8 py-4 bg-luxury-gold text-white rounded-full text-xs font-bold uppercase tracking-widest hover:bg-luxury-gold/90 disabled:opacity-30 disabled:cursor-not-allowed transition-all shadow-xl"
          >
            {isProcessing ? (
              <>
                <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin mr-2" />
                Đang xử lý...
              </>
            ) : (
              <>
                Trích xuất dữ liệu
                <ChevronRight className="w-5 h-5 ml-2" />
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );

  const renderStep3 = () => {
    const dbKeys = Object.keys(dbData[0] || {});
    const nameKey = dbKeys.find(k => k.toLowerCase().includes('tên') || k.toLowerCase().includes('name')) || dbKeys[1];
    const codeKey = dbKeys.find(k => k.toLowerCase().includes('mã') || k.toLowerCase().includes('code')) || dbKeys[0];

    return (
      <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
        <div className="glass rounded-3xl shadow-xl overflow-hidden">
          <div className="p-6 sm:p-8 border-b border-white/50 flex justify-between items-center bg-white/30">
            <h3 className="text-lg sm:text-xl font-bold text-slate-grey uppercase tracking-tight">Kết quả đối chiếu</h3>
            <span className="px-4 py-1.5 bg-luxury-gold/10 text-luxury-gold text-xs font-bold uppercase tracking-widest rounded-full border border-luxury-gold/20">
              {extractedItems.length} mặt hàng
            </span>
          </div>
          
          <div className="overflow-x-auto hidden md:block">
            <table className="w-full text-sm text-left">
              <thead className="text-[10px] text-slate-grey/50 uppercase tracking-[0.2em] bg-white/20 border-b border-white/50">
                <tr>
                  <th className="px-8 py-5 font-bold">Tên trên hóa đơn</th>
                  <th className="px-8 py-5 font-bold">Số lượng</th>
                  <th className="px-8 py-5 font-bold">Đơn giá</th>
                  <th className="px-8 py-5 font-bold">Mặt hàng KiotViet (Đối chiếu)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/50">
                {extractedItems.map((item) => (
                  <tr key={item.id} className={cn("hover:bg-white/40 transition-colors", !item.matchedProduct && "bg-red-50/20")}>
                    <td className="px-8 py-6">
                      <div className="font-bold text-slate-grey">{item.originalName}</div>
                      {(item.dimensions || item.thickness) && (
                        <div className="text-[10px] font-bold uppercase tracking-wider text-slate-grey/40 mt-2 flex flex-wrap gap-2">
                          {item.dimensions && <span className="bg-white/50 px-2.5 py-1 rounded-full border border-white/50">KT: {item.dimensions}</span>}
                          {item.thickness && <span className="bg-white/50 px-2.5 py-1 rounded-full border border-white/50">Dày: {item.thickness}</span>}
                        </div>
                      )}
                    </td>
                    <td className="px-8 py-6">
                      <input
                        type="number"
                        min="1"
                        className="w-20 px-3 py-2 text-sm border border-slate-grey/10 rounded-xl focus:outline-none focus:ring-2 focus:ring-luxury-gold/30 focus:border-luxury-gold/50 bg-white/50 font-bold text-slate-grey"
                        value={item.quantity}
                        onChange={(e) => handleQuantityChange(item.id, Number(e.target.value))}
                      />
                    </td>
                    <td className="px-8 py-6">
                      <div className="relative">
                        <input
                          type="text"
                          className="w-32 px-3 py-2 text-sm border border-slate-grey/10 rounded-xl focus:outline-none focus:ring-2 focus:ring-luxury-gold/30 focus:border-luxury-gold/50 bg-white/50 font-bold text-slate-grey"
                          value={item.price ? item.price.toLocaleString('vi-VN') : ''}
                          onChange={(e) => {
                            const rawValue = e.target.value.replace(/\D/g, '');
                            const numValue = rawValue ? parseInt(rawValue, 10) : 0;
                            handlePriceChange(item.id, numValue);
                          }}
                        />
                      </div>
                    </td>
                    <td className="px-8 py-6">
                      {item.matchedProduct ? (
                        <div className="flex items-start text-luxury-gold bg-white/50 px-4 py-3 rounded-2xl border border-luxury-gold/20 relative group shadow-sm">
                          <CheckCircle2 className="w-4 h-4 mr-3 shrink-0 mt-0.5" />
                          <div className="flex-1 min-w-0 pr-8">
                            <div className="font-bold text-sm uppercase tracking-tight">{item.matchedProduct[nameKey]}</div>
                            <div className="text-[10px] font-bold text-luxury-gold/60 mt-2 flex flex-wrap gap-1.5 uppercase tracking-wider">
                              {Object.entries(item.matchedProduct).map(([k, v]) => {
                                const lowerK = k.toLowerCase();
                                const excludedKeys = ['giá', 'tồn', 'nhóm', 'loại', 'thương hiệu', 'dự kiến', 'đvt', 'mã hh', 'hình ảnh', 'mô tả', 'kh đặt', 'quy đổi', 'đang kinh doanh', 'được bán trực tiếp', 'thời gian tạo'];
                                const shouldExclude = excludedKeys.some(ex => lowerK.includes(ex));
                                if (k !== nameKey && k !== codeKey && v && !shouldExclude) {
                                  return <span key={k} className="bg-white/80 px-2 py-0.5 rounded-full border border-luxury-gold/10">{k}: {String(v)}</span>;
                                }
                                return null;
                              })}
                            </div>
                          </div>
                          <button
                            onClick={() => handleClearMatch(item.id)}
                            className="absolute right-3 top-3 p-1.5 text-luxury-gold/40 hover:text-red-500 hover:bg-red-50 rounded-full transition-all"
                            title="Đổi mặt hàng khác"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                      ) : (
                        <div className="space-y-3">
                          <div className="flex items-center text-red-500 text-[10px] font-bold uppercase tracking-widest mb-2">
                            <AlertCircle className="w-4 h-4 mr-2" />
                            Không tìm thấy mặt hàng khớp
                          </div>
                          <ProductSearch 
                            dbData={dbData} 
                            nameKey={nameKey} 
                            codeKey={codeKey}
                            onSelect={(dbItem) => handleManualMatch(item.id, dbItem)} 
                            initialQuery={item.rawName}
                          />
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile View */}
          <div className="md:hidden divide-y divide-white/50">
            {extractedItems.map((item) => (
              <div key={item.id} className={cn("p-6 space-y-6", !item.matchedProduct && "bg-red-50/10")}>
                <div>
                  <div className="font-bold text-slate-grey text-base">{item.originalName}</div>
                  {(item.dimensions || item.thickness) && (
                    <div className="text-[10px] font-bold uppercase tracking-wider text-slate-grey/40 mt-2 flex flex-wrap gap-2">
                      {item.dimensions && <span className="bg-white/50 px-2.5 py-1 rounded-full border border-white/50">KT: {item.dimensions}</span>}
                      {item.thickness && <span className="bg-white/50 px-2.5 py-1 rounded-full border border-white/50">Dày: {item.thickness}</span>}
                    </div>
                  )}
                </div>
                
                <div className="flex gap-4">
                  <div className="flex-1">
                    <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-grey/40 mb-2">Số lượng</label>
                    <input
                      type="number"
                      min="1"
                      className="w-full px-4 py-2.5 text-sm border border-slate-grey/10 rounded-xl focus:outline-none focus:ring-2 focus:ring-luxury-gold/30 focus:border-luxury-gold/50 bg-white/50 font-bold text-slate-grey"
                      value={item.quantity}
                      onChange={(e) => handleQuantityChange(item.id, Number(e.target.value))}
                    />
                  </div>
                  <div className="flex-1">
                    <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-grey/40 mb-2">Đơn giá</label>
                    <input
                      type="text"
                      className="w-full px-4 py-2.5 text-sm border border-slate-grey/10 rounded-xl focus:outline-none focus:ring-2 focus:ring-luxury-gold/30 focus:border-luxury-gold/50 bg-white/50 font-bold text-slate-grey"
                      value={item.price ? item.price.toLocaleString('vi-VN') : ''}
                      onChange={(e) => {
                        const rawValue = e.target.value.replace(/\D/g, '');
                        const numValue = rawValue ? parseInt(rawValue, 10) : 0;
                        handlePriceChange(item.id, numValue);
                      }}
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-grey/40 mb-2">Mặt hàng KiotViet (Đối chiếu)</label>
                  {item.matchedProduct ? (
                    <div className="flex items-start text-luxury-gold bg-white/50 px-4 py-3 rounded-2xl border border-luxury-gold/20 relative group shadow-sm">
                      <CheckCircle2 className="w-4 h-4 mr-3 shrink-0 mt-0.5" />
                      <div className="flex-1 min-w-0 pr-8">
                        <div className="font-bold text-sm uppercase tracking-tight">{item.matchedProduct[nameKey]}</div>
                        <div className="text-[10px] font-bold text-luxury-gold/60 mt-2 flex flex-wrap gap-1.5 uppercase tracking-wider">
                          {Object.entries(item.matchedProduct).map(([k, v]) => {
                            const lowerK = k.toLowerCase();
                            const excludedKeys = ['giá', 'tồn', 'nhóm', 'loại', 'thương hiệu', 'dự kiến', 'đvt', 'mã hh', 'hình ảnh', 'mô tả', 'kh đặt', 'quy đổi', 'đang kinh doanh', 'được bán trực tiếp', 'thời gian tạo'];
                            const shouldExclude = excludedKeys.some(ex => lowerK.includes(ex));
                            if (k !== nameKey && k !== codeKey && v && !shouldExclude) {
                              return <span key={k} className="bg-white/80 px-2 py-0.5 rounded-full border border-luxury-gold/10">{k}: {String(v)}</span>;
                            }
                            return null;
                          })}
                        </div>
                      </div>
                      <button
                        onClick={() => handleClearMatch(item.id)}
                        className="absolute right-3 top-3 p-1.5 text-luxury-gold/40 hover:text-red-500 hover:bg-red-50 rounded-full transition-all"
                        title="Đổi mặt hàng khác"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <div className="flex items-center text-red-500 text-[10px] font-bold uppercase tracking-widest mb-2">
                        <AlertCircle className="w-4 h-4 mr-2" />
                        Không tìm thấy mặt hàng khớp
                      </div>
                      <ProductSearch 
                        dbData={dbData} 
                        nameKey={nameKey} 
                        codeKey={codeKey}
                        onSelect={(dbItem) => handleManualMatch(item.id, dbItem)} 
                        initialQuery={item.rawName}
                      />
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
          
        <div className="flex flex-col sm:flex-row justify-between items-center gap-6 p-6 sm:p-8 border-t border-white/50 bg-white/30">
          <button
            onClick={() => setStep(2)}
            className="inline-flex items-center justify-center px-8 py-4 bg-white border border-slate-grey/20 text-slate-grey rounded-full text-xs font-bold uppercase tracking-widest hover:bg-beige transition-all shadow-sm"
          >
            Quay lại tải ảnh
          </button>
          <div className="flex flex-col sm:flex-row gap-4 w-full sm:w-auto">
            <button
              onClick={() => saveAllMatches(true)}
              disabled={isSavingMatches || extractedItems.every(i => !i.matchedProduct)}
              className="inline-flex items-center justify-center px-8 py-4 bg-white border border-slate-grey/20 text-slate-grey rounded-full text-xs font-bold uppercase tracking-widest hover:bg-beige transition-all shadow-sm disabled:opacity-30"
            >
              {isSavingMatches ? (
                <div className="w-4 h-4 border-2 border-slate-grey/30 border-t-slate-grey rounded-full animate-spin mr-3" />
              ) : (
                <Save className="w-4 h-4 mr-3" />
              )}
              Lưu kết quả
            </button>
            <button
              onClick={exportExcel}
              disabled={isSavingMatches}
              className="inline-flex items-center justify-center px-10 py-4 bg-luxury-gold text-white rounded-full text-xs font-bold uppercase tracking-[0.2em] hover:bg-luxury-gold/90 transition-all shadow-xl disabled:opacity-50"
            >
              <Download className="w-4 h-4 sm:w-5 sm:h-5 mr-3" />
              Xuất File Excel
            </button>
          </div>
        </div>
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-beige text-slate-grey font-sans selection:bg-luxury-gold/30">
      {/* Header */}
      <header className="glass sticky top-0 z-50 shadow-sm">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 h-20 flex items-center justify-between">
          <div className="flex items-center space-x-3 sm:space-x-4 min-w-0">
            <div className="w-10 h-10 sm:w-12 sm:h-12 bg-slate-grey rounded-xl flex items-center justify-center shadow-lg overflow-hidden">
              <img src="https://picsum.photos/seed/rose-logo/100/100" alt="Mận Quý Logo" className="w-full h-full object-cover" />
            </div>
            <h1 className="text-lg sm:text-2xl font-bold tracking-tight text-slate-grey truncate uppercase letter-spacing-wide drop-shadow-sm">TẠO FILE NHẬP</h1>
          </div>
          <div className="flex items-center space-x-4">
            <button
              onClick={async () => {
                if ((window as any).aistudio?.openSelectKey) {
                  try {
                    await (window as any).aistudio.openSelectKey();
                  } catch (e) {
                    console.error("Lỗi khi mở chọn key:", e);
                  }
                } else {
                  setShowApiKeyModal(true);
                }
              }}
              className={cn(
                "p-2.5 rounded-full transition-all shadow-sm border",
                hasCustomKey 
                  ? "bg-green-50 border-green-200 text-green-600 hover:bg-green-100" 
                  : "bg-white border-slate-grey/20 text-slate-grey hover:bg-slate-grey/5"
              )}
              title="Cấu hình API Key cá nhân"
            >
              <Key className="w-4 h-4" />
            </button>
            {hasCustomKey && (
              <div className="hidden md:flex items-center px-3 py-1 bg-green-50 border border-green-200 rounded-full">
                <div className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse mr-2" />
                <span className="text-[10px] font-bold text-green-700 uppercase tracking-widest">Custom API</span>
              </div>
            )}
            {user ? (
              <div className="flex items-center space-x-3">
                <span className="text-xs font-semibold text-slate-grey/60 uppercase tracking-widest hidden sm:inline-block">
                  {user.displayName || user.email}
                </span>
                <button
                  onClick={handleLogout}
                  className="inline-flex items-center px-4 py-2 border border-slate-grey/20 rounded-full text-xs font-bold uppercase tracking-widest text-slate-grey bg-white/50 hover:bg-white transition-all shadow-sm"
                  title="Đăng xuất"
                >
                  <LogOut className="w-3.5 h-3.5 sm:mr-2" />
                  <span className="hidden sm:inline-block">Đăng xuất</span>
                </button>
              </div>
            ) : (
              <button
                onClick={handleLogin}
                className="inline-flex items-center px-5 py-2.5 border border-transparent rounded-full text-xs font-bold uppercase tracking-widest text-white bg-slate-grey hover:bg-slate-grey/90 transition-all shadow-md"
              >
                <LogIn className="w-4 h-4 mr-2" />
                Đăng nhập
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
        {/* Banner */}
        <div className="mb-12 rounded-3xl overflow-hidden shadow-2xl border border-white/50 relative h-48 sm:h-64 md:h-80 bg-cream group">
          <img 
            src="https://picsum.photos/seed/rose-bedroom/1920/1080" 
            alt="Mận Quý Banner" 
            className="absolute inset-0 w-full h-full object-cover transition-transform duration-1000 group-hover:scale-105"
            referrerPolicy="no-referrer"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-black/40 to-transparent flex flex-col justify-end p-8">
            <h2 className="text-white text-2xl sm:text-4xl font-bold mb-2 drop-shadow-lg">CỬA HÀNG MẬN QUÝ</h2>
            <p className="text-white/80 text-sm sm:text-base max-w-md drop-shadow-md">Ngày Mới May Mắn, Mua May Bán Đắt</p>
          </div>
        </div>

        {/* Steps Indicator */}
        <div className="mb-12 px-4">
          <div className="flex items-center justify-between relative">
            <div className="absolute left-0 top-1/2 -translate-y-1/2 w-full h-0.5 bg-slate-grey/10 -z-10"></div>
            <div className="absolute left-0 top-1/2 -translate-y-1/2 h-0.5 bg-luxury-gold -z-10 transition-all duration-700 ease-out" style={{ width: `${(step - 1) * 50}%` }}></div>
            
            {[1, 2, 3].map((s) => (
              <div key={s} className={cn(
                "w-12 h-12 rounded-full flex items-center justify-center text-sm font-bold border-2 transition-all duration-500 shadow-sm",
                step >= s ? "border-luxury-gold bg-white text-luxury-gold" : "border-slate-grey/20 bg-white/50 text-slate-grey/40",
                step === s && "bg-luxury-gold text-white scale-110 shadow-lg"
              )}>
                {s}
              </div>
            ))}
          </div>
          <div className="flex justify-between mt-4 text-[10px] uppercase tracking-[0.2em] font-bold text-slate-grey/50 px-1">
            <span>Thiết lập</span>
            <span>Tải ảnh</span>
            <span>Đối chiếu</span>
          </div>
        </div>

        {/* Error Alert */}
        {error && (
          <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-2xl flex flex-col text-red-700 animate-in fade-in">
            <div className="flex items-start">
              <AlertCircle className="w-5 h-5 mr-3 shrink-0 mt-0.5" />
              <p className="text-sm font-medium">{error}</p>
            </div>
            {error.includes("hạn mức") && (
              <div className="mt-4 pt-4 border-t border-red-200 flex flex-col sm:flex-row sm:items-center gap-3">
                <button 
                  onClick={async () => {
                    if ((window as any).aistudio?.openSelectKey) {
                      try {
                        await (window as any).aistudio.openSelectKey();
                        setError(null);
                      } catch (e) {
                        console.error("Lỗi khi mở chọn key:", e);
                      }
                    } else {
                      setShowApiKeyModal(true);
                      setError(null);
                    }
                  }}
                  className="px-6 py-2.5 bg-red-600 text-white text-[10px] font-bold rounded-full hover:bg-red-700 transition-all uppercase tracking-widest shadow-md"
                >
                  Cấu hình API Key cá nhân
                </button>
                <p className="text-[10px] text-red-600/70 italic">
                  * Sử dụng Key cá nhân để tránh giới hạn lượt dùng chung.
                </p>
              </div>
            )}
          </div>
        )}

        {/* Success Alert */}
        {successMessage && (
          <div className="mb-6 p-4 bg-green-50 border border-green-200 rounded-lg flex items-start text-green-700 animate-in fade-in">
            <CheckCircle2 className="w-5 h-5 mr-3 shrink-0 mt-0.5" />
            <p className="text-sm">{successMessage}</p>
          </div>
        )}

        {/* Content */}
        {step === 1 && renderStep1()}
        {step === 2 && renderStep2()}
        {step === 3 && renderStep3()}
      </main>

      {/* Image Preview Modal */}
      {selectedImage && (
        <div 
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/90 p-4 animate-in fade-in duration-200"
          onClick={() => setSelectedImage(null)}
        >
          <button 
            className="absolute top-4 right-4 p-2 bg-white/10 text-white rounded-full hover:bg-white/20 transition-colors"
            onClick={() => setSelectedImage(null)}
          >
            <X className="w-6 h-6" />
          </button>
          <img 
            src={selectedImage} 
            alt="Preview" 
            className="max-w-full max-h-full object-contain rounded-lg shadow-2xl animate-in zoom-in-95 duration-200"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}

      {/* API Key Modal */}
      {showApiKeyModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4 animate-in fade-in">
          <div className="bg-white rounded-2xl p-6 max-w-md w-full shadow-2xl">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-bold text-slate-grey">Cấu hình Gemini API Key</h3>
              <button onClick={() => setShowApiKeyModal(false)} className="p-1 hover:bg-slate-100 rounded-full">
                <X className="w-5 h-5 text-slate-grey/60" />
              </button>
            </div>
            <p className="text-sm text-slate-grey/70 mb-4">
              Nhập API Key của bạn để sử dụng ứng dụng không giới hạn. Key sẽ được lưu an toàn trên trình duyệt của bạn.
            </p>
            <input
              type="password"
              value={localApiKey}
              onChange={(e) => setLocalApiKey(e.target.value)}
              placeholder="AIzaSy..."
              className="w-full px-4 py-3 rounded-xl border border-slate-grey/20 focus:border-luxury-gold focus:ring-1 focus:ring-luxury-gold outline-none mb-6 font-mono text-sm"
            />
            <div className="flex justify-end space-x-3">
              <button
                onClick={() => {
                  localStorage.removeItem('gemini_api_key');
                  setLocalApiKey('');
                  setHasCustomKey(false);
                  setShowApiKeyModal(false);
                }}
                className="px-4 py-2 text-sm font-bold text-red-600 hover:bg-red-50 rounded-lg transition-colors"
              >
                Xóa Key
              </button>
              <button
                onClick={() => {
                  if (localApiKey.trim()) {
                    localStorage.setItem('gemini_api_key', localApiKey.trim());
                    setHasCustomKey(true);
                  }
                  setShowApiKeyModal(false);
                }}
                className="px-6 py-2 bg-luxury-gold text-white text-sm font-bold rounded-lg hover:bg-luxury-gold/90 transition-colors shadow-md"
              >
                Lưu Key
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// --- Helper Component for Product Search ---
function ProductSearch({ dbData, nameKey, codeKey, onSelect, initialQuery = '' }: { dbData: any[], nameKey: string, codeKey: string, onSelect: (item: any) => void, initialQuery?: string }) {
  const [query, setQuery] = useState(initialQuery);
  const [isOpen, setIsOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const filtered = query === '' 
    ? dbData.slice(0, 20) 
    : dbData.filter(item => {
        const normalizedQuery = normalizeString(query);
        const searchTerms = normalizedQuery.split(' ').filter(Boolean);
        const searchableText = Object.entries(item)
          .filter(([k, v]) => v && (typeof v === 'string' || typeof v === 'number'))
          .map(([k, v]) => normalizeString(String(v)))
          .join(' ');
        
        // Standard term-by-term match
        const matchesAllTerms = searchTerms.every(term => searchableText.includes(term));
        if (matchesAllTerms) return true;

        // Fallback: No-space match (handles "pe 3f" matching "pe 3 f")
        const queryNoSpace = normalizedQuery.replace(/\s+/g, '');
        const textNoSpace = searchableText.replace(/\s+/g, '');
        return textNoSpace.includes(queryNoSpace);
      }).slice(0, 50);

  return (
    <div className="relative" ref={wrapperRef}>
      <div className="relative">
        <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-grey/40" />
        <input
          type="text"
          className="w-full pl-11 pr-10 py-3 text-sm border border-slate-grey/10 rounded-2xl focus:outline-none focus:ring-2 focus:ring-luxury-gold/30 focus:border-luxury-gold/50 bg-white/50 font-medium text-slate-grey placeholder:text-slate-grey/30"
          placeholder="Tìm tên hoặc mã hàng..."
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIsOpen(true);
          }}
          onFocus={() => setIsOpen(true)}
        />
        {query && (
          <button
            onClick={() => {
              setQuery('');
              setIsOpen(true);
            }}
            className="absolute right-3 top-1/2 -translate-y-1/2 p-1.5 text-slate-grey/30 hover:text-slate-grey rounded-full transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
      
      {isOpen && (
        <div className="absolute z-50 w-full mt-2 glass rounded-2xl shadow-2xl max-h-80 overflow-auto animate-in fade-in zoom-in-95 duration-200">
          {filtered.length === 0 ? (
            <div className="p-6 text-xs font-bold uppercase tracking-widest text-slate-grey/40 text-center">Không tìm thấy kết quả</div>
          ) : (
            <ul className="py-2">
              {filtered.map((item, idx) => (
                <li 
                  key={idx}
                  className="px-6 py-4 hover:bg-beige cursor-pointer flex flex-col border-b border-white/50 last:border-0 transition-colors"
                  onClick={() => {
                    onSelect(item);
                    setIsOpen(false);
                    setQuery('');
                  }}
                >
                  <span className="text-sm font-bold text-slate-grey uppercase tracking-tight">{item[nameKey]}</span>
                  <div className="flex flex-wrap gap-2 text-[10px] font-bold text-slate-grey/40 mt-2 uppercase tracking-wider">
                    {Object.entries(item).map(([k, v]) => {
                      const lowerK = k.toLowerCase();
                      const excludedKeys = ['giá', 'tồn', 'nhóm', 'loại', 'thương hiệu', 'dự kiến', 'đvt', 'mã hh', 'hình ảnh', 'mô tả', 'kh đặt', 'quy đổi', 'đang kinh doanh', 'được bán trực tiếp', 'thời gian tạo'];
                      const shouldExclude = excludedKeys.some(ex => lowerK.includes(ex));
                      if (k !== nameKey && k !== codeKey && v && !shouldExclude) {
                        return <span key={k} className="bg-white/50 px-2 py-0.5 rounded-full border border-white/50">{k}: {String(v)}</span>;
                      }
                      return null;
                    })}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};

