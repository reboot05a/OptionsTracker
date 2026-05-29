import { useState, useEffect, useCallback } from 'react';
import { accountsApi } from '../services/api';

const STORAGE_KEY = 'optionable_selectedAccountId';

export const useAccounts = () => {
    const [accounts, setAccounts] = useState([]);
    const [selectedAccountId, setSelectedAccountIdState] = useState(() => {
        const stored = localStorage.getItem(STORAGE_KEY);
        return stored ? Number(stored) : null;
    });
    const [loading, setLoading] = useState(true);

    const setSelectedAccountId = useCallback((id) => {
        setSelectedAccountIdState(id);
        if (id !== null) {
            localStorage.setItem(STORAGE_KEY, String(id));
        } else {
            localStorage.removeItem(STORAGE_KEY);
        }
    }, []);

    const fetchAccounts = useCallback(async () => {
        try {
            setLoading(true);
            const response = await accountsApi.getAll();
            const data = response.data.map(a => ({ ...a, id: Number(a.id) }));
            setAccounts(data);

            setSelectedAccountIdState(prev => {
                // If current selection no longer exists, fall back
                if (prev && !data.find(a => Number(a.id) === Number(prev))) {
                    localStorage.removeItem(STORAGE_KEY);
                    prev = null;
                }
                // Auto-select: if nothing selected, pick the only account (or first)
                if (!prev && data.length > 0) {
                    const id = data.length === 1 ? data[0].id : data[0].id;
                    localStorage.setItem(STORAGE_KEY, String(id));
                    return Number(id);
                }
                return prev;
            });
        } catch (err) {
            console.error('Error fetching accounts:', err);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchAccounts();
    }, []);

    const createAccount = useCallback(async (name, commissionPerContract, accountValue) => {
        const data = { name };
        if (commissionPerContract !== undefined) data.commissionPerContract = commissionPerContract;
        if (accountValue !== undefined) data.accountValue = accountValue;
        const response = await accountsApi.create(data);
        await fetchAccounts();
        return response.data;
    }, [fetchAccounts]);

    const renameAccount = useCallback(async (id, name, commissionPerContract, accountValue) => {
        const data = { name };
        if (commissionPerContract !== undefined) data.commissionPerContract = commissionPerContract;
        if (accountValue !== undefined) data.accountValue = accountValue;
        const response = await accountsApi.update(id, data);
        await fetchAccounts();
        return response.data;
    }, [fetchAccounts]);

    const deleteAccount = useCallback(async (id) => {
        await accountsApi.delete(id);
        if (selectedAccountId === id) {
            setSelectedAccountId(null);
        }
        await fetchAccounts();
    }, [fetchAccounts, selectedAccountId, setSelectedAccountId]);

    return {
        accounts,
        selectedAccountId,
        setSelectedAccountId,
        loading,
        fetchAccounts,
        createAccount,
        renameAccount,
        deleteAccount
    };
};
