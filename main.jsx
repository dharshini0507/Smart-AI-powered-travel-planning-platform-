
import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import './index.css'
import Home from './pages/Home.jsx'
import Login from './pages/Login.jsx'
import Signup from './pages/Signup.jsx'
import AdminLogin from './pages/AdminLogin.jsx'
import Dashboard from './pages/Dashboard.jsx'
import NewPlan from './pages/NewPlan.jsx'
import TripView from './pages/TripView.jsx'
import AdminDashboard from './pages/AdminDashboard.jsx'

function AppShell() {
  const token = localStorage.getItem('token')
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/login" element={<Login />} />
        <Route path="/signup" element={<Signup />} />
        <Route path="/admin" element={<AdminLogin />} />
        <Route path="/dashboard" element={<Dashboard/>} />
        <Route path="/new" element={<NewPlan/>} />
        <Route path="/trip/:id" element={<TripView/>} />
        <Route path="/admin/dashboard" element={<AdminDashboard/>} />
      </Routes>
    </BrowserRouter>
  )
}

ReactDOM.createRoot(document.getElementById('root')).render(<AppShell/>)
