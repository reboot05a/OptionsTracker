import { useState, useCallback, useRef } from 'react';
import { API_URL } from '../utils/constants';

const initialFormState = {
    ticker: '',
    openedDate: new Date().toISOString().split('T')[0],
    expirationDate: '',
    closedDate: '',
    strike: '',
    type: 'CC',
    quantity: 1,
    delta: '',
    iv: '',
    entryPrice: '',
    closePrice: '',
    status: 'Open',
    parentTradeId: null,
    notes: '',
    commission: '',
    score: '',
};

export const useTradeForm = ({ refreshAll, showToast, setError, setCurrentPage, accountId }) => {
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [formData, setFormData] = useState(initialFormState);
    const [editingId, setEditingId] = useState(null);
    const [isRolling, setIsRolling] = useState(false);
    const [rollFromTrade, setRollFromTrade] = useState(null);
    const [rollClosePrice, setRollClosePrice] = useState('');
    const [modalAccountId, setModalAccountId] = useState(null);

    // Stores { ticker, run_date } when opened via openFromProspect.
    // After a successful save we fire POST /api/prospects/status automatically.
    const _prospectRef = useRef(null);

    const handleInputChange = useCallback((e) => {
        const { name, value } = e.target;
        setFormData(prev => ({ ...prev, [name]: value }));
    }, []);

    const openModal = useCallback((trade = null) => {
        setIsRolling(false);
        setRollFromTrade(null);
        setModalAccountId(null);
        if (trade) {
            setEditingId(trade.id);
            setFormData({
                ticker: trade.ticker,
                openedDate: trade.openedDate,
                expirationDate: trade.expirationDate,
                closedDate: trade.closedDate || '',
                strike: trade.strike,
                type: trade.type,
                quantity: trade.quantity,
                delta: trade.delta || '',
                iv: trade.iv ?? '',
                entryPrice: trade.entryPrice,
                closePrice: trade.closePrice || '',
                status: trade.status,
                parentTradeId: trade.parentTradeId || null,
                notes: trade.notes || '',
                commission: trade.commission ? trade.commission : '',
                score: trade.score ?? '',
            });
        } else {
            setEditingId(null);
            setFormData({
                ...initialFormState,
                openedDate: new Date().toISOString().split('T')[0]
            });
        }
        setIsModalOpen(true);
    }, []);

    const duplicateTrade = useCallback((trade) => {
        setEditingId(null);
        setIsRolling(false);
        setRollFromTrade(null);
        setModalAccountId(null);
        setFormData({
            ticker: trade.ticker,
            openedDate: new Date().toISOString().split('T')[0],
            expirationDate: '',
            closedDate: '',
            strike: trade.strike,
            type: trade.type,
            quantity: trade.quantity,
            delta: '',
            iv: '',
            entryPrice: '',
            closePrice: '',
            status: 'Open',
            parentTradeId: null,
            notes: '',
            commission: '',
        });
        setIsModalOpen(true);
    }, []);

    const rollTrade = useCallback((trade) => {
        setEditingId(null);
        setIsRolling(true);
        setRollFromTrade(trade);
        setRollClosePrice('');
        setModalAccountId(null);
        setFormData({
            ticker: trade.ticker,
            openedDate: new Date().toISOString().split('T')[0],
            expirationDate: '',
            closedDate: '',
            strike: '',
            type: trade.type,
            quantity: trade.quantity,
            delta: '',
            iv: '',
            entryPrice: '',
            closePrice: '',
            status: 'Open',
            parentTradeId: trade.id,
            notes: '',
            commission: '',
        });
        setIsModalOpen(true);
    }, []);

    const openCoveredCall = useCallback((cspTrade) => {
        setEditingId(null);
        setIsRolling(false);
        setRollFromTrade(null);
        setModalAccountId(null);
        setFormData({
            ticker: cspTrade.ticker,
            openedDate: new Date().toISOString().split('T')[0],
            expirationDate: '',
            closedDate: '',
            strike: '',
            type: 'CC',
            quantity: cspTrade.quantity,
            delta: '',
            iv: '',
            entryPrice: '',
            closePrice: '',
            status: 'Open',
            parentTradeId: cspTrade.id,
            notes: '',
            commission: '',
        });
        setIsModalOpen(true);
    }, []);

    // Opens the TradeModal pre-filled from a cc_daily_candidates prospect row.
    // After the user saves the trade, status=ENTERED is written back automatically.
    const openFromProspect = useCallback((candidate, accountId) => {
        _prospectRef.current = {
            ticker:   candidate.ticker,
            run_date: candidate.run_date,
        };
        setEditingId(null);
        setIsRolling(false);
        setRollFromTrade(null);
        // Use live contract details when available and valid, fall back to report.
        const lc = candidate.live_contract;
        const strike     = lc?.strike          ?? candidate.strike;
        const expDate    = lc?.expiration_date  ?? candidate.expiration_date;
        // Entry price: prefer live call_mid (snapshot), then report premium_mid.
        const entryPrice = candidate.call_mid   ?? candidate.premium_mid ?? '';
        setModalAccountId(accountId || null);
        setFormData({
            ...initialFormState,
            openedDate:     new Date().toISOString().split('T')[0],
            ticker:         candidate.ticker,
            type:           'CC',
            strike:         strike        ?? '',
            expirationDate: expDate       ? String(expDate).slice(0, 10) : '',
            delta:          candidate.delta   ?? '',
            iv:             candidate.iv      ?? '',
            entryPrice:     entryPrice !== '' ? String(entryPrice) : '',
            score:          candidate.score   ?? '',
            status:         'Open',
        });
        setIsModalOpen(true);
    }, []);

    const closeModal = useCallback(() => {
        setIsModalOpen(false);
        setFormData(initialFormState);
        setEditingId(null);
        setIsRolling(false);
        setRollFromTrade(null);
        setRollClosePrice('');
        setModalAccountId(null);
        _prospectRef.current = null;
    }, []);

    const saveTrade = useCallback(async (e) => {
        e.preventDefault();

        // Validation for rolling
        if (isRolling && rollFromTrade) {
            if (!rollClosePrice && rollClosePrice !== 0) {
                setError('Please enter the close cost for the original position');
                return;
            }
            if (!formData.strike) {
                setError('Please enter the new strike price');
                return;
            }
            if (!formData.entryPrice) {
                setError('Please enter the new premium');
                return;
            }
            if (!formData.expirationDate) {
                setError('Please enter the new expiration date');
                return;
            }
        }

        const tradeData = {
            ticker: formData.ticker,
            type: formData.type,
            strike: Number(formData.strike),
            quantity: Number(formData.quantity),
            delta: formData.delta ? Number(formData.delta) : null,
            iv: formData.iv !== '' && formData.iv !== null && formData.iv !== undefined ? Number(formData.iv) : null,
            entryPrice: Number(formData.entryPrice),
            closePrice: formData.closePrice ? Number(formData.closePrice) : 0,
            openedDate: formData.openedDate,
            expirationDate: formData.expirationDate,
            closedDate: formData.closedDate || null,
            status: formData.status,
            parentTradeId: formData.parentTradeId || null,
            notes: formData.notes || null,
            accountId: accountId || modalAccountId || null,
            score: formData.score !== '' && formData.score !== null ? Number(formData.score) : null,
        };
        // Only send commission if user explicitly set it (non-empty string)
        if (formData.commission !== '' && formData.commission !== null && formData.commission !== undefined) {
            tradeData.commission = Number(formData.commission);
        }

        try {
            if (isRolling && rollFromTrade) {
                const response = await fetch(`${API_URL}/trades/roll`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        originalTradeId: rollFromTrade.id,
                        closePrice: Number(rollClosePrice),
                        newTrade: tradeData,
                    }),
                });

                if (!response.ok) throw new Error('Failed to roll trade');
            } else {
                const url = editingId ? `${API_URL}/trades/${editingId}` : `${API_URL}/trades`;
                const method = editingId ? 'PUT' : 'POST';

                const response = await fetch(url, {
                    method,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(tradeData),
                });

                if (!response.ok) throw new Error('Failed to save trade');
            }

            await refreshAll();

            // If this trade was opened from a Prospects card, mark it ENTERED.
            const prospect = _prospectRef.current;
            if (prospect && !editingId && !isRolling) {
                try {
                    await fetch(`${API_URL}/prospects/status`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            ticker: prospect.ticker,
                            date:   prospect.run_date,
                            status: 'ENTERED',
                        }),
                    });
                } catch (prospectErr) {
                    // Non-fatal — trade is already saved; log and continue.
                    console.warn('Could not update prospect status:', prospectErr);
                }
                _prospectRef.current = null;
            }

            closeModal();
            if (!editingId) setCurrentPage(1);
        } catch (err) {
            console.error('Error saving trade:', err);
            setError('Failed to save trade. Please try again.');
        }
    }, [isRolling, rollFromTrade, rollClosePrice, formData, editingId, accountId, modalAccountId, refreshAll, closeModal, setError, setCurrentPage]);

    const deleteTrade = useCallback(async (id) => {
        if (!window.confirm('Are you sure you want to delete this trade?')) return;

        try {
            const response = await fetch(`${API_URL}/trades/${id}`, { method: 'DELETE' });
            if (!response.ok) throw new Error('Failed to delete trade');
            await refreshAll();
            showToast('Trade deleted');
        } catch (err) {
            console.error('Error deleting trade:', err);
            setError('Failed to delete trade. Please try again.');
        }
    }, [refreshAll, showToast, setError]);

    const quickCloseTrade = useCallback(async (trade) => {
        try {
            const response = await fetch(`${API_URL}/trades/${trade.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    closePrice: 0,
                    closedDate: new Date().toISOString().split('T')[0],
                    status: 'Expired',
                }),
            });
            if (!response.ok) throw new Error('Failed to close trade');
            await refreshAll();
            showToast(`${trade.ticker} closed at $0`);
        } catch (err) {
            console.error('Error closing trade:', err);
            setError('Failed to close trade. Please try again.');
        }
    }, [refreshAll, showToast, setError]);

    return {
        isModalOpen,
        formData,
        setFormData,
        editingId,
        isRolling,
        rollFromTrade,
        rollClosePrice,
        setRollClosePrice,
        modalAccountId,
        setModalAccountId,
        handleInputChange,
        openModal,
        closeModal,
        duplicateTrade,
        rollTrade,
        openCoveredCall,
        openFromProspect,
        saveTrade,
        deleteTrade,
        quickCloseTrade
    };
};
